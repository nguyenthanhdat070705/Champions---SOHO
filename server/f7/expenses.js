// Functional 07 — the expense service (spec §7 / §9 / §10). Every money mutation
// runs in ONE Postgres transaction over the pooler (F3/F5 pattern); the pooler
// bypasses RLS, so the caller was already authorised in the router (JWT +
// membership/role) before reaching here. Core guarantees:
//   • Server is the sole authority for every total (spec 4.1 / EXP-02) — the
//     client/OCR grand_total is never trusted.
//   • Post is atomic: expense→posted + payment fact snapshot + ONE accounting_event
//     (pending) + duplicate findings + audit, all-or-nothing (EXP-FR-08 / EXP-03/04).
//   • Idempotent: a same-key double-tap replays; a posted expense replays; the
//     accounting_events unique (source_type,source_id,event_type) is the durable
//     dedup backstop (EXP-05 / EXP-06 / EXP-15).
//   • A posted expense is immutable — correction is reversal, never edit/delete
//     (spec 4.3 / EXP-11).
import { createHash } from "node:crypto";
import { query, withTransaction, getPool } from "../db/pool.js";
import { DomainError, fail } from "../f3/errors.js";
import { writeAudit, enqueueOutbox } from "../f3/audit.js";
import { expenseNumber } from "../f3/numbering.js";
import { runIdempotent, bodyHash } from "../f5/idem.js";
import { computeTotals } from "./money.js";
import { loadCategory } from "./categories.js";
import { findDuplicates } from "./duplicates.js";

const EDITABLE_STATES = new Set(["draft", "extracting", "review", "ready"]);
const PAYMENT_METHODS = new Set(["cash", "transfer", "other"]);

/** Today in the merchant's timezone (Asia/Ho_Chi_Minh), 'YYYY-MM-DD'. */
export function vnToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/**
 * pg returns a `date` column as a JS Date at LOCAL midnight; String(date) gives
 * "Sun Aug 16 2026 …" and toISOString() can shift a day. Read the local calendar
 * components instead so we always get the true YYYY-MM-DD.
 */
function isoDate(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function normDate(d) {
  if (!d) return vnToday();
  const s = String(d).slice(0, 10);
  if (!ISO_DATE.test(s)) fail("VALIDATION", "Ngày chi không hợp lệ.");
  // Not too far in the future (spec 3.3): allow up to +1 day for tz slack.
  const today = vnToday();
  const diff = (Date.parse(`${s}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  if (diff > 1) fail("VALIDATION", "Ngày chi không được ở tương lai.");
  return s;
}

function normMethod(m, fallback = "cash") {
  const v = String(m || fallback).toLowerCase();
  if (!PAYMENT_METHODS.has(v)) fail("VALIDATION", "Phương thức thanh toán không hợp lệ.");
  return v;
}

// ── mappers ──────────────────────────────────────────────────────────────────
function mapExpenseRow(r) {
  return {
    id: r.id,
    expenseNumber: r.expense_number,
    status: r.status,
    expenseDate: isoDate(r.expense_date),
    payeeName: r.payee_name_snapshot,
    categoryId: r.category_id,
    categoryName: r.category_display_name ?? null,
    documentId: r.document_id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    subtotalVnd: Number(r.subtotal_vnd),
    taxAmountVnd: Number(r.tax_amount_vnd),
    grandTotalVnd: Number(r.grand_total_vnd),
    rowVersion: Number(r.row_version),
    createdAt: r.created_at,
    postedAt: r.posted_at,
    reversedAt: r.reversed_at,
  };
}

function mapItem(r) {
  return {
    id: r.id,
    description: r.description,
    quantity: Number(r.quantity),
    unitCostVnd: Number(r.unit_cost_vnd),
    lineTotalVnd: Number(r.line_total_vnd),
    taxAmountVnd: Number(r.tax_amount_vnd),
    source: r.source,
    confidence: r.confidence == null ? null : Number(r.confidence),
  };
}

async function insertItems(client, merchantId, expenseId, items) {
  for (const it of items) {
    await client.query(
      `insert into public.expense_items
         (merchant_id, expense_id, description, quantity, unit_cost_vnd, line_total_vnd, tax_amount_vnd, source, confidence)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [merchantId, expenseId, it.description, it.quantity, it.unitCostVnd, it.lineTotalVnd, it.taxAmountVnd, it.source, it.confidence],
    );
  }
}

async function upsertPaymentFact(client, merchantId, expenseId, { method, confirmationStatus, userId }) {
  const confirmed = confirmationStatus === "confirmed";
  await client.query(
    `insert into public.expense_payment_facts
       (expense_id, merchant_id, method, confirmation_status, confirmed_by, confirmed_at)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (expense_id) do update
       set method=$3, confirmation_status=$4,
           confirmed_by = case when $4='confirmed' then $5 else null end,
           confirmed_at = case when $4='confirmed' then coalesce(expense_payment_facts.confirmed_at,$6) else null end`,
    [expenseId, merchantId, method, confirmationStatus, confirmed ? userId : null, confirmed ? new Date().toISOString() : null],
  );
}

/** Full expense detail (spec 3.8): header + items + payment fact + document + open dup findings. */
export async function getExpense(merchantId, expenseId) {
  const pool = getPool();
  const head = await pool.query(
    `select e.*, c.display_name as category_display_name
       from public.expenses e
       left join public.expense_categories c on c.id = e.category_id
      where e.id=$1 and e.merchant_id=$2`,
    [expenseId, merchantId],
  );
  if (head.rows.length === 0) fail("EXPENSE_NOT_FOUND");
  const expense = mapExpenseRow(head.rows[0]);

  const [items, fact, doc, dups, events] = await Promise.all([
    pool.query(`select * from public.expense_items where expense_id=$1 order by id`, [expenseId]),
    pool.query(`select method, confirmation_status, confirmed_by, confirmed_at, evidence_document_id
                  from public.expense_payment_facts where expense_id=$1`, [expenseId]),
    expense.documentId
      ? pool.query(`select id, document_number, mime_type, byte_size, content_hash, object_key, status
                      from public.source_documents where id=$1`, [expense.documentId])
      : Promise.resolve({ rows: [] }),
    pool.query(
      `select f.id, f.candidate_expense_id, f.signals, f.status, f.created_at,
              e2.expense_number, e2.grand_total_vnd, e2.expense_date, e2.payee_name_snapshot
         from public.expense_duplicate_findings f
         join public.expenses e2 on e2.id = f.candidate_expense_id
        where f.expense_id=$1 order by f.created_at desc`,
      [expenseId]),
    pool.query(`select id, event_type, amount_vnd, review_status, created_at
                  from public.accounting_events where source_type='expense' and source_id=$1 order by created_at`, [expenseId]),
  ]);

  return {
    expense,
    items: items.rows.map(mapItem),
    paymentFact: fact.rows[0] ? {
      method: fact.rows[0].method,
      confirmationStatus: fact.rows[0].confirmation_status,
      confirmedBy: fact.rows[0].confirmed_by,
      confirmedAt: fact.rows[0].confirmed_at,
      evidenceDocumentId: fact.rows[0].evidence_document_id,
    } : null,
    document: doc.rows[0] ? {
      id: doc.rows[0].id, documentNumber: doc.rows[0].document_number,
      mimeType: doc.rows[0].mime_type, byteSize: doc.rows[0].byte_size == null ? null : Number(doc.rows[0].byte_size),
      contentHash: doc.rows[0].content_hash, status: doc.rows[0].status,
    } : null,
    duplicateFindings: dups.rows.map((f) => ({
      id: f.id, candidateExpenseId: f.candidate_expense_id, signals: f.signals, status: f.status, createdAt: f.created_at,
      candidate: { expenseNumber: f.expense_number, grandTotalVnd: Number(f.grand_total_vnd),
        expenseDate: isoDate(f.expense_date), payeeName: f.payee_name_snapshot },
    })),
    accountingEvents: events.rows.map((e) => ({
      id: e.id, eventType: e.event_type, amountVnd: Number(e.amount_vnd), reviewStatus: e.review_status, createdAt: e.created_at,
    })),
  };
}

/** Monthly list (spec 3.1). month='YYYY-MM' (default current); filter status/category; search number/payee. */
export async function listExpenses(merchantId, { month, status, categoryId, search, limit } = {}) {
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : vnToday().slice(0, 7);
  const monthStart = `${m}-01`;
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const params = [merchantId, monthStart];
  let where = `e.merchant_id=$1 and e.expense_date >= $2::date and e.expense_date < ($2::date + interval '1 month')`;
  if (status && status !== "all") { params.push(status); where += ` and e.status=$${params.length}`; }
  if (categoryId) { params.push(categoryId); where += ` and e.category_id=$${params.length}`; }
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    where += ` and (e.expense_number ilike $${params.length} or e.payee_name_snapshot ilike $${params.length})`;
  }
  params.push(lim);
  const { rows } = await query(
    `select e.id, e.expense_number, e.status, e.expense_date, e.payee_name_snapshot,
            e.grand_total_vnd, e.category_id, e.document_id, e.source_type,
            c.display_name as category_display_name,
            pf.method as payment_method, pf.confirmation_status as payment_status
       from public.expenses e
       left join public.expense_categories c on c.id=e.category_id
       left join public.expense_payment_facts pf on pf.expense_id=e.id
      where ${where}
      order by e.expense_date desc, e.created_at desc
      limit $${params.length}`,
    params,
  );
  // Month posted total (net of reversed) for the header.
  const { rows: sum } = await query(
    `select coalesce(sum(grand_total_vnd),0) as total, count(*)::int as n
       from public.expenses
      where merchant_id=$1 and status='posted'
        and expense_date >= $2::date and expense_date < ($2::date + interval '1 month')`,
    [merchantId, monthStart],
  );
  return {
    month: m,
    expenses: rows.map((r) => ({
      id: r.id, expenseNumber: r.expense_number, status: r.status,
      expenseDate: isoDate(r.expense_date), payeeName: r.payee_name_snapshot,
      grandTotalVnd: Number(r.grand_total_vnd), categoryId: r.category_id,
      categoryName: r.category_display_name, hasDocument: Boolean(r.document_id),
      sourceType: r.source_type, paymentMethod: r.payment_method, paymentStatus: r.payment_status,
    })),
    summary: { postedTotalVnd: Number(sum[0].total), postedCount: sum[0].n },
  };
}

/**
 * POST /expenses — create a draft (manual or from a photo-filled form / F06 event).
 * Idempotent per (merchant, Idempotency-Key). A source-backed draft (sourceId set)
 * that already exists replays the SAME expense via the expenses_source_uq index
 * (spec 5.1: one source → one expense).
 */
export async function createDraft(merchantId, userId, input, idemKey) {
  const expenseDate = normDate(input.expenseDate);
  const payee = input.payeeName ? String(input.payeeName).slice(0, 200) : null;
  const totals = computeTotals({ items: input.items, amountVnd: input.amountVnd, headerTaxVnd: input.headerTaxVnd });
  const sourceType = input.sourceType && String(input.sourceType).trim() ? String(input.sourceType).trim() : "manual";
  const sourceId = input.sourceId || null;
  const method = input.paymentMethod ? normMethod(input.paymentMethod) : null;
  const confirmationStatus = input.paymentConfirmed ? "confirmed" : "unconfirmed";

  const canonical = { expenseDate, payee, sourceType, sourceId, grand: totals.grandTotalVnd, items: totals.items.length };

  const { result, replayed } = await runIdempotent("expense-create", idemKey, bodyHash(canonical), async () => {
    const { expenseId } = await withTransaction(async (client) => {
      // Category (optional at draft; required at post).
      let categoryId = null;
      if (input.categoryId) categoryId = (await loadCategory(client, merchantId, input.categoryId)).id;

      // One source → one expense: the partial unique index (merchant, source_type,
      // source_id) WHERE source_id IS NOT NULL dedups F06-style sources. ON CONFLICT
      // DO NOTHING avoids aborting the transaction so we can replay the existing row
      // (a try/catch on 23505 could not — the tx would already be aborted).
      const ins = await client.query(
        `insert into public.expenses
           (merchant_id, expense_number, status, expense_date, payee_name_snapshot, category_id,
            document_id, source_type, source_id, subtotal_vnd, tax_amount_vnd, grand_total_vnd, created_by)
         values ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (merchant_id, source_type, source_id) where source_id is not null do nothing
         returning id`,
        [merchantId, expenseNumber(expenseDate), expenseDate, payee, categoryId, input.documentId || null,
         sourceType, sourceId, totals.subtotalVnd, totals.taxAmountVnd, totals.grandTotalVnd, userId],
      );
      if (ins.rows.length === 0) {
        // Source already has an expense → replay it (no new items/audit).
        const ex = await client.query(
          `select id from public.expenses where merchant_id=$1 and source_type=$2 and source_id=$3`,
          [merchantId, sourceType, sourceId]);
        return { expenseId: ex.rows[0]?.id };
      }
      const newId = ins.rows[0].id;

      if (totals.items.length) await insertItems(client, merchantId, newId, totals.items);
      if (method) await upsertPaymentFact(client, merchantId, newId, { method, confirmationStatus, userId });

      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "expense.created", entityType: "expense", entityId: newId,
        after: { expenseDate, grandTotalVnd: totals.grandTotalVnd, sourceType, sourceId, items: totals.items.length },
      });
      return { expenseId: newId };
    });
    // Read the full detail AFTER commit — getExpense uses a fresh pool connection
    // that cannot see an uncommitted row.
    return getExpense(merchantId, expenseId);
  });
  return { ...result, replayed };
}

/** PATCH /expenses/:id — edit a draft (spec 3.x). Posted/reversed are immutable. */
export async function updateDraft(merchantId, userId, expenseId, input, ifMatchVersion) {
  await withTransaction(async (client) => {
    const cur = await client.query(
      `select * from public.expenses where id=$1 and merchant_id=$2 for update`, [expenseId, merchantId]);
    if (cur.rows.length === 0) fail("EXPENSE_NOT_FOUND");
    const row = cur.rows[0];
    if (!EDITABLE_STATES.has(row.status)) fail("EXPENSE_NOT_EDITABLE");
    if (ifMatchVersion != null && Number(row.row_version) !== Number(ifMatchVersion)) {
      throw new DomainError("VERSION_CONFLICT", undefined, { current: { rowVersion: Number(row.row_version) } });
    }

    const expenseDate = input.expenseDate !== undefined ? normDate(input.expenseDate) : isoDate(row.expense_date);
    const payee = input.payeeName !== undefined ? (input.payeeName ? String(input.payeeName).slice(0, 200) : null) : row.payee_name_snapshot;
    let categoryId = row.category_id;
    if (input.categoryId !== undefined) categoryId = input.categoryId ? (await loadCategory(client, merchantId, input.categoryId)).id : null;
    const documentId = input.documentId !== undefined ? (input.documentId || null) : row.document_id;

    // Recompute totals whenever items OR a single amount is supplied.
    let subtotal = Number(row.subtotal_vnd), tax = Number(row.tax_amount_vnd), grand = Number(row.grand_total_vnd);
    let newItems = null;
    if (input.items !== undefined || input.amountVnd !== undefined || input.headerTaxVnd !== undefined) {
      const totals = computeTotals({ items: input.items, amountVnd: input.amountVnd, headerTaxVnd: input.headerTaxVnd });
      subtotal = totals.subtotalVnd; tax = totals.taxAmountVnd; grand = totals.grandTotalVnd; newItems = totals.items;
    }
    if (newItems !== null) {
      await client.query(`delete from public.expense_items where expense_id=$1`, [expenseId]);
      if (newItems.length) await insertItems(client, merchantId, expenseId, newItems);
    }
    if (input.paymentMethod !== undefined) {
      await upsertPaymentFact(client, merchantId, expenseId, {
        method: normMethod(input.paymentMethod),
        confirmationStatus: input.paymentConfirmed ? "confirmed" : "unconfirmed", userId });
    }

    await client.query(
      `update public.expenses
          set expense_date=$1, payee_name_snapshot=$2, category_id=$3, document_id=$4,
              subtotal_vnd=$5, tax_amount_vnd=$6, grand_total_vnd=$7,
              status = case when status='draft' then 'review' else status end,
              row_version=row_version+1
        where id=$8`,
      [expenseDate, payee, categoryId, documentId, subtotal, tax, grand, expenseId]);

    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "expense.updated", entityType: "expense", entityId: expenseId,
      after: { expenseDate, grandTotalVnd: grand } });
  });
  return getExpense(merchantId, expenseId); // read after commit (fresh connection)
}

/** Candidate duplicates for a target expense (posted, same amount, date ±1, similar payee / same doc). */
async function detectDuplicates(client, merchantId, target) {
  const { rows } = await client.query(
    `select e.id, e.expense_number, e.grand_total_vnd, e.expense_date, e.payee_name_snapshot as payee, sd.content_hash
       from public.expenses e
       left join public.source_documents sd on sd.id=e.document_id
      where e.merchant_id=$1 and e.id<>$2 and e.status='posted'
        and e.expense_date between $3::date - 1 and $3::date + 1`,
    [merchantId, target.id, target.expenseDate]);
  const candidates = rows.map((r) => ({
    id: r.id, expenseNumber: r.expense_number, grandTotalVnd: Number(r.grand_total_vnd),
    expenseDate: isoDate(r.expense_date), payee: r.payee, contentHash: r.content_hash,
  }));
  const fired = findDuplicates(target, candidates);
  return fired.map((f) => {
    const c = candidates.find((x) => x.id === f.candidateExpenseId);
    return { ...f, candidate: c };
  });
}

/**
 * POST /expenses/:id/post — the atomic commit (spec 7.1 / 9.3). Recomputes totals,
 * gates on duplicates (unless acknowledged), snapshots the payment fact, writes ONE
 * accounting_event (pending), records duplicate findings, and flips the expense to
 * posted — all in one transaction. Idempotent; a posted expense replays.
 */
export async function postExpense(merchantId, userId, role, expenseId, input, idemKey) {
  const ack = input?.duplicateReview?.status === "NOT_DUPLICATE";
  const expectedVersion = input?.expectedVersion != null ? Number(input.expectedVersion) : null;
  const paymentIn = input?.paymentFact || {};

  const canonical = { expenseId, ack, method: paymentIn.method || null, conf: paymentIn.confirmationStatus || null };

  const { result, replayed } = await runIdempotent(`expense-post`, idemKey, bodyHash(canonical), async () => {
    return withTransaction(async (client) => {
      const cur = await client.query(
        `select * from public.expenses where id=$1 and merchant_id=$2 for update`, [expenseId, merchantId]);
      if (cur.rows.length === 0) fail("EXPENSE_NOT_FOUND");
      const row = cur.rows[0];

      if (row.status === "posted") {
        // Replay (spec 5.1 EXP_007): return the same result without double-posting.
        const ev = await client.query(
          `select id from public.accounting_events where source_type='expense' and source_id=$1 and event_type='expense_posted'`, [expenseId]);
        return { expenseId, expenseNumber: row.expense_number, status: "posted",
          grandTotalVnd: Number(row.grand_total_vnd), accountingEventId: ev.rows[0]?.id ?? null,
          duplicates: [], alreadyPosted: true };
      }
      if (row.status === "reversed" || row.status === "cancelled") fail("EXPENSE_NOT_EDITABLE");
      if (expectedVersion != null && Number(row.row_version) !== expectedVersion) {
        throw new DomainError("VERSION_CONFLICT", undefined, { current: { rowVersion: Number(row.row_version) } });
      }

      // Category required before post (spec 4.1 / EXP-03).
      if (!row.category_id) fail("CATEGORY_REQUIRED");
      await loadCategory(client, merchantId, row.category_id);

      // Recompute totals from the stored items — the server never trusts a total (EXP-02).
      const it = await client.query(
        `select coalesce(sum(line_total_vnd),0) as sub, coalesce(sum(tax_amount_vnd),0) as tax, count(*)::int as n
           from public.expense_items where expense_id=$1`, [expenseId]);
      const hasItems = it.rows[0].n > 0;
      const subtotal = hasItems ? Number(it.rows[0].sub) : Number(row.subtotal_vnd);
      const tax = hasItems ? Number(it.rows[0].tax) : Number(row.tax_amount_vnd);
      const grand = subtotal + tax;
      if (!(grand > 0)) fail("AMOUNT_REQUIRED");

      const target = {
        id: expenseId, grandTotalVnd: grand, expenseDate: isoDate(row.expense_date),
        payee: row.payee_name_snapshot, contentHash: null,
      };
      if (row.document_id) {
        const d = await client.query(`select content_hash from public.source_documents where id=$1`, [row.document_id]);
        target.contentHash = d.rows[0]?.content_hash ?? null;
      }
      const dups = await detectDuplicates(client, merchantId, target);
      if (dups.length && !ack) {
        throw new DomainError("POSSIBLE_DUPLICATE_EXPENSE", undefined, {
          action: "REVIEW_DUPLICATE_CANDIDATES",
          candidates: dups.map((d) => ({
            expenseId: d.candidateExpenseId, expenseNumber: d.candidate?.expenseNumber,
            totalVnd: d.candidate?.grandTotalVnd, expenseDate: d.candidate?.expenseDate,
            payee: d.candidate?.payee, signals: d.signals,
          })),
        });
      }

      // Payment fact snapshot (spec 4.3): the fact the user confirms, not bank reconcile.
      const existingFact = await client.query(
        `select method, confirmation_status from public.expense_payment_facts where expense_id=$1`, [expenseId]);
      const method = normMethod(paymentIn.method || existingFact.rows[0]?.method || "cash");
      const confirmationStatus = (paymentIn.confirmationStatus === "confirmed") ? "confirmed"
        : (paymentIn.confirmationStatus === "unconfirmed" ? "unconfirmed"
          : (existingFact.rows[0]?.confirmation_status || "unconfirmed"));
      await upsertPaymentFact(client, merchantId, expenseId, { method, confirmationStatus, userId });

      // ONE accounting_event (pending) — the downstream interface (spec 4.3 / 7.2).
      const ev = await client.query(
        `insert into public.accounting_events (merchant_id, source_type, source_id, event_type, amount_vnd, review_status)
         values ($1,'expense',$2,'expense_posted',$3,'pending')
         on conflict (source_type, source_id, event_type) do nothing
         returning id`,
        [merchantId, expenseId, grand]);
      let accountingEventId = ev.rows[0]?.id ?? null;
      if (!accountingEventId) {
        const again = await client.query(
          `select id from public.accounting_events where source_type='expense' and source_id=$1 and event_type='expense_posted'`, [expenseId]);
        accountingEventId = again.rows[0]?.id ?? null;
      }

      await client.query(
        `update public.expenses
            set status='posted', posted_by=$1, posted_at=now(),
                subtotal_vnd=$2, tax_amount_vnd=$3, grand_total_vnd=$4, row_version=row_version+1
          where id=$5`,
        [userId, subtotal, tax, grand, expenseId]);

      // Record duplicate findings (open) so they surface in the findings list (spec 4.2).
      for (const d of dups) {
        await client.query(
          `insert into public.expense_duplicate_findings (merchant_id, expense_id, candidate_expense_id, signals, status)
           values ($1,$2,$3,$4,'open')
           on conflict (expense_id, candidate_expense_id) do nothing`,
          [merchantId, expenseId, d.candidateExpenseId, JSON.stringify(d.signals)]);
      }

      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "expense.posted", entityType: "expense", entityId: expenseId,
        after: { grandTotalVnd: grand, categoryId: row.category_id, paymentMethod: method,
          confirmationStatus, accountingEventId, duplicateCandidates: dups.length } });
      await enqueueOutbox(client, {
        merchantId, eventType: "expense.posted", aggregateId: expenseId,
        payload: { expenseId, grandTotalVnd: grand, accountingEventId } });

      return {
        expenseId, expenseNumber: row.expense_number, status: "posted",
        grandTotalVnd: grand, accountingEventId, duplicates: dups.length,
      };
    });
  });
  return { ...result, replayed };
}

/**
 * POST /expenses/:id/reverse — appends a reversal accounting_event and flips the
 * expense to 'reversed' (spec 3.8 / 4.3 / EXP-11). The original row is never
 * edited/deleted. A second reverse is blocked by the accounting_events unique +
 * the status check → EXPENSE_ALREADY_REVERSED (EXP-12). Idempotent per key.
 */
export async function reverseExpense(merchantId, userId, role, expenseId, input, idemKey) {
  const reason = String(input?.reason || "").trim() || "CORRECTION";
  const canonical = { expenseId, reason };
  const { result, replayed } = await runIdempotent("expense-reverse", idemKey, bodyHash(canonical), async () => {
    return withTransaction(async (client) => {
      const cur = await client.query(
        `select * from public.expenses where id=$1 and merchant_id=$2 for update`, [expenseId, merchantId]);
      if (cur.rows.length === 0) fail("EXPENSE_NOT_FOUND");
      const row = cur.rows[0];
      if (row.status === "reversed") fail("EXPENSE_ALREADY_REVERSED");
      if (row.status !== "posted") fail("EXPENSE_NOT_POSTED");

      const ev = await client.query(
        `insert into public.accounting_events (merchant_id, source_type, source_id, event_type, amount_vnd, review_status)
         values ($1,'expense',$2,'expense_reversed',$3,'pending')
         on conflict (source_type, source_id, event_type) do nothing
         returning id`,
        [merchantId, expenseId, Number(row.grand_total_vnd)]);
      if (ev.rows.length === 0) fail("EXPENSE_ALREADY_REVERSED"); // durable double-reverse guard

      await client.query(
        `update public.expenses set status='reversed', reversed_at=now(), row_version=row_version+1 where id=$1`, [expenseId]);

      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "expense.reversed", entityType: "expense", entityId: expenseId,
        before: { status: "posted", grandTotalVnd: Number(row.grand_total_vnd) },
        after: { status: "reversed", reason, reversalEventId: ev.rows[0].id } });
      await enqueueOutbox(client, {
        merchantId, eventType: "expense.reversed", aggregateId: expenseId,
        payload: { expenseId, reversalEventId: ev.rows[0].id, reason } });

      return { expenseId, status: "reversed", reversalEventId: ev.rows[0].id };
    });
  });
  return { ...result, replayed };
}

/** GET /expenses/:id/duplicates — open findings for an expense (spec 10). */
export async function listDuplicateFindings(merchantId, expenseId) {
  const full = await getExpense(merchantId, expenseId);
  return { findings: full.duplicateFindings };
}

/** POST /expenses/:id/duplicate-decision — dismiss/confirm a finding (spec 4.2 / 10). */
export async function decideDuplicate(merchantId, userId, expenseId, findingId, decision) {
  const status = decision === "confirmed" ? "confirmed" : decision === "dismissed" ? "dismissed" : null;
  if (!status) fail("VALIDATION", "Quyết định không hợp lệ.");
  return withTransaction(async (client) => {
    const upd = await client.query(
      `update public.expense_duplicate_findings set status=$1
        where id=$2 and expense_id=$3 and merchant_id=$4 returning id`,
      [status, findingId, expenseId, merchantId]);
    if (upd.rows.length === 0) fail("DUPLICATE_FINDING_NOT_FOUND");
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "expense.duplicate_decided", entityType: "expense", entityId: expenseId,
      after: { findingId, decision: status } });
    return { findingId, status };
  });
}

/** Ensure a source_documents row for a captured receipt (metadata + content hash). */
export async function ensureReceiptDocument(merchantId, userId, { base64, mimeType, documentNumber }) {
  const buf = Buffer.from(base64, "base64");
  const contentHash = createHash("sha256").update(buf).digest("hex");
  // Reuse an existing document with the same content hash (spec 2.2: don't re-hash/re-upload).
  const existing = await query(
    `select id from public.source_documents where merchant_id=$1 and content_hash=$2 limit 1`, [merchantId, contentHash]);
  if (existing.rows.length) return { documentId: existing.rows[0].id, contentHash, reused: true };
  const objectKey = `expenses/${merchantId}/${contentHash}`;
  const { rows } = await query(
    `insert into public.source_documents
       (merchant_id, object_key, content_hash, sha256, mime_type, byte_size, document_number, document_type, status, created_by)
     values ($1,$2,$3,$3,$4,$5,$6,'expense_receipt','ready',$7)
     returning id`,
    [merchantId, objectKey, contentHash, mimeType || "image/jpeg", buf.length, documentNumber || null, userId]);
  return { documentId: rows[0].id, contentHash, reused: false };
}
