// Functional 09 — the e-invoice orchestration service (spec 1, 4, 7, 9, 10). Every
// money/state mutation runs in ONE Postgres transaction over the pooler, exactly
// like F3/F5; the router already verified JWT + membership/role before we get here
// (the pooler bypasses RLS, so this module is a tenant guard too — every query is
// scoped by merchant_id). The provider network call happens AFTER commit (spec 9.3),
// never while holding a DB transaction.
//
// Source of truth (spec 7.2): the paid order owns the sale facts; the e_invoice
// frozen snapshot owns the submitted payload; a VERIFIED provider event owns the
// accepted/rejected status. No screen or HTTP 2xx may claim "accepted".
import { query, withTransaction, getPool } from "../db/pool.js";
import { DomainError, fail } from "../f3/errors.js";
import { writeAudit, enqueueOutbox } from "../f3/audit.js";
import { deterministicUuid } from "../f5/movements.js";
import { runIdempotent, bodyHash } from "../f5/idem.js";
import { RULE_SET_VERSION, resolveLineTax, taxLabelOf } from "./mapping.js";
import { buildInvoiceLines, sumInvoiceTotals, buildCanonicalPayload, payloadHashOf } from "./totals.js";
import { validateInvoice as runValidation, normalizeTaxId } from "./validation.js";
import { reduceProviderEvent, isEditable, canRetry, canRelate } from "./state.js";
import { getProvider, MockProvider } from "./provider.js";

// The deployed e_invoices.invoice_kind default is 'original'; the partial-unique
// (merchant_id, order_id, invoice_kind) enforces one active original per order.
const KIND_ORIGINAL = "original";
const PROVIDER_CODE = "mock";

/** Eligible = a fully-paid bill. A partial refund keeps status='paid' (F03 quirk),
 *  a fully-returned bill is 'refunded' and is NOT eligible. */
function isEligibleOrderStatus(status) {
  return status === "paid";
}

// ── Snapshots / mappers ──────────────────────────────────────────────────────

function mapOrderItemRow(r) {
  return {
    id: r.id, productId: r.product_id, lineNo: r.line_no, name: r.name_snapshot,
    sku: r.sku_snapshot, unitCode: r.unit_code_snapshot, unitPrice: Number(r.unit_price),
    quantity: Number(r.quantity), grossAmount: Number(r.gross_amount),
    discountAmount: Number(r.discount_amount), netAmount: Number(r.net_amount), note: r.note,
  };
}

/** Freeze the seller identity from the merchant profile (spec 3.3 / 8.1). */
async function loadSellerSnapshot(client, merchantId) {
  const { rows } = await client.query(
    `select display_name, legal_name, tax_code_normalized from public.merchants where id=$1`,
    [merchantId],
  );
  if (!rows.length) fail("INVOICE_NOT_FOUND", "Không tìm thấy cửa hàng.");
  const m = rows[0];
  return {
    legalName: (m.legal_name || m.display_name || "").trim() || null,
    displayName: m.display_name || null,
    taxCode: m.tax_code_normalized ? normalizeTaxId(m.tax_code_normalized) : null,
    address: null, // single-line address handoff is out of MVP scope (documented)
  };
}

function mapInvoiceRow(r) {
  return {
    id: r.id, merchantId: r.merchant_id, orderId: r.order_id, profileId: r.profile_id,
    invoiceKind: r.invoice_kind, status: r.status,
    sellerSnapshot: r.seller_snapshot || {}, buyerSnapshot: r.buyer_snapshot || {},
    subtotalVnd: Number(r.subtotal_vnd), taxVnd: Number(r.tax_vnd), totalVnd: Number(r.total_vnd),
    ruleSetVersion: r.rule_set_version, payloadHash: r.payload_hash,
    providerInvoiceRef: r.provider_invoice_ref, rowVersion: Number(r.row_version),
    createdBy: r.created_by, createdAt: r.created_at,
  };
}

function mapItemRow(r) {
  return {
    id: r.id, orderItemId: r.order_item_id, description: r.description, unit: r.unit,
    quantity: Number(r.quantity), unitPriceVnd: Number(r.unit_price_vnd),
    taxCode: r.tax_code, taxRate: Number(r.tax_rate), taxLabel: taxLabelOf(r.tax_code),
    lineTotalVnd: Number(r.line_total_vnd), taxVnd: Number(r.tax_vnd),
  };
}

/** Assemble the full invoice aggregate (header + items + submissions + events + relations). */
async function loadInvoiceAggregate(clientOrPool, merchantId, invoiceId) {
  const q = (t, p) => clientOrPool.query(t, p);
  const inv = await q(`select * from public.e_invoices where id=$1 and merchant_id=$2`, [invoiceId, merchantId]);
  if (!inv.rows.length) fail("INVOICE_NOT_FOUND");
  const invoice = mapInvoiceRow(inv.rows[0]);
  const items = await q(`select * from public.e_invoice_items where invoice_id=$1 order by id`, [invoiceId]);
  const subs = await q(
    `select id, attempt_no, client_request_id, status, provider_code, provider_message, submitted_at, created_at
       from public.e_invoice_submissions where invoice_id=$1 order by attempt_no`, [invoiceId]);
  const events = await q(
    `select provider_code, provider_event_id, event_type, occurred_at, signature_valid, processed_at
       from public.e_invoice_provider_events where invoice_id=$1 order by occurred_at`, [invoiceId]);
  const rels = await q(
    `select id, original_invoice_id, related_invoice_id, relation_type, reason, created_at
       from public.e_invoice_relations
      where merchant_id=$1 and (original_invoice_id=$2 or related_invoice_id=$2) order by created_at`,
    [merchantId, invoiceId]);
  invoice.items = items.rows.map(mapItemRow);
  invoice.submissions = subs.rows.map((s) => ({
    id: s.id, attemptNo: s.attempt_no, clientRequestId: s.client_request_id, status: s.status,
    providerCode: s.provider_code, providerMessage: s.provider_message,
    submittedAt: s.submitted_at, createdAt: s.created_at,
  }));
  invoice.events = events.rows.map((e) => ({
    providerCode: e.provider_code, providerEventId: e.provider_event_id, eventType: e.event_type,
    occurredAt: e.occurred_at, signatureValid: e.signature_valid, processedAt: e.processed_at,
  }));
  invoice.relations = rels.rows.map((r) => ({
    id: r.id, originalInvoiceId: r.original_invoice_id, relatedInvoiceId: r.related_invoice_id,
    relationType: r.relation_type, reason: r.reason, createdAt: r.created_at,
    direction: r.original_invoice_id === invoiceId ? "outgoing" : "incoming",
  }));
  return invoice;
}

/** Insert the item snapshots for an invoice (shared by create/retry/relation).
 *  e_invoice_items carries a NOT-NULL merchant_id (deployed schema). */
async function insertItems(client, merchantId, invoiceId, lines) {
  for (const l of lines) {
    await client.query(
      `insert into public.e_invoice_items
         (merchant_id, invoice_id, order_item_id, description, unit, quantity, unit_price_vnd, tax_code, tax_rate, line_total_vnd, tax_vnd)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [merchantId, invoiceId, l.orderItemId, l.description, l.unit, l.quantity, l.unitPriceVnd, l.taxCode, l.taxRate, l.lineTotalVnd, l.taxVnd],
    );
  }
}

/** Read + snapshot an order's lines through the tax mapping into invoice lines. */
async function orderLinesFor(client, orderId) {
  const rows = await client.query(`select * from public.order_items where order_id=$1 order by line_no`, [orderId]);
  const orderItems = rows.rows.map(mapOrderItemRow);
  const lines = buildInvoiceLines(orderItems);
  return { lines, totals: sumInvoiceTotals(lines) };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** GET /e-invoices — status/search filtered card list (spec 3.1). */
export async function listInvoices(merchantId, { status, search, limit = 50 } = {}) {
  const params = [merchantId];
  let where = "e.merchant_id=$1";
  if (status) {
    if (status === "processing") { where += ` and e.status in ('submitting')`; }
    else { params.push(status); where += ` and e.status=$${params.length}`; }
  }
  if (search) {
    params.push(`%${String(search).trim()}%`);
    where += ` and (o.order_number ilike $${params.length} or e.buyer_snapshot->>'name' ilike $${params.length} or e.provider_invoice_ref ilike $${params.length})`;
  }
  params.push(Math.min(200, Number(limit) || 50));
  const { rows } = await query(
    `select e.id, e.status, e.invoice_kind, e.total_vnd, e.buyer_snapshot, e.provider_invoice_ref,
            e.created_at, o.order_number
       from public.e_invoices e join public.orders o on o.id=e.order_id
      where ${where}
      order by e.created_at desc
      limit $${params.length}`,
    params,
  );
  return {
    invoices: rows.map((r) => ({
      id: r.id, status: r.status, invoiceKind: r.invoice_kind, totalVnd: Number(r.total_vnd),
      buyerName: (r.buyer_snapshot && r.buyer_snapshot.name) || null,
      providerInvoiceRef: r.provider_invoice_ref, orderNumber: r.order_number, createdAt: r.created_at,
    })),
  };
}

/** GET /orders/invoice-eligible — paid bills with no active original invoice (spec 3.2). */
export async function listEligibleOrders(merchantId, { search, limit = 30 } = {}) {
  const params = [merchantId];
  let where = `o.merchant_id=$1 and o.status='paid'
    and not exists (select 1 from public.e_invoices e
      where e.order_id=o.id and e.merchant_id=$1 and e.invoice_kind='sale' and e.status not in ('rejected','cancelled'))`;
  if (search) {
    params.push(`%${String(search).trim()}%`);
    where += ` and o.order_number ilike $${params.length}`;
  }
  params.push(Math.min(100, Number(limit) || 30));
  const { rows } = await query(
    `select o.id, o.order_number, o.total_amount, o.paid_at, o.created_at,
            (select count(*) from public.order_items oi where oi.order_id=o.id) as item_count
       from public.orders o
      where ${where}
      order by o.paid_at desc nulls last, o.created_at desc
      limit $${params.length}`,
    params,
  );
  return {
    orders: rows.map((r) => ({
      id: r.id, orderNumber: r.order_number, totalAmount: Number(r.total_amount),
      paidAt: r.paid_at, createdAt: r.created_at, itemCount: Number(r.item_count),
    })),
  };
}

/** GET /e-invoices/:id — full detail. */
export async function getInvoice(merchantId, invoiceId) {
  return loadInvoiceAggregate(getPool(), merchantId, invoiceId);
}

// ── Draft ────────────────────────────────────────────────────────────────────

/** POST /e-invoices — create a draft from a paid order (spec 3.2, INV-01/02). */
export async function createDraft(merchantId, userId, input, idemKey) {
  if (!idemKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const orderId = input.orderId;
  const buyerKind = input.buyerKind === "organization" ? "organization" : "individual";
  const canonical = { orderId, kind: KIND_ORIGINAL };
  const { result, replayed } = await runIdempotent("einvoice-draft", idemKey, bodyHash(canonical), async () =>
    withTransaction(async (client) => {
      // Lock the order row FIRST — two devices racing on the same bill serialize
      // here, so only one draft is created (INV-02); the other sees it and returns it.
      const o = await client.query(`select id, status from public.orders where id=$1 and merchant_id=$2 for update`, [orderId, merchantId]);
      if (!o.rows.length) fail("ORDER_NOT_FOUND");
      if (!isEligibleOrderStatus(o.rows[0].status)) fail("ORDER_NOT_ELIGIBLE"); // INV-01

      const existing = await client.query(
        `select id from public.e_invoices
          where merchant_id=$1 and order_id=$2 and invoice_kind=$3 and status not in ('rejected','cancelled') limit 1`,
        [merchantId, orderId, KIND_ORIGINAL]);
      if (existing.rows.length) {
        const inv = await loadInvoiceAggregate(client, merchantId, existing.rows[0].id);
        return { invoice: inv, existing: true };
      }

      const seller = await loadSellerSnapshot(client, merchantId);
      const { lines, totals } = await orderLinesFor(client, orderId);
      const buyer = { kind: buyerKind, name: null, taxCode: null, address: null, email: null };
      const profileId = deterministicUuid(`einvoice-profile:${merchantId}`);

      const ins = await client.query(
        `insert into public.e_invoices
           (merchant_id, order_id, profile_id, invoice_kind, status, seller_snapshot, buyer_snapshot,
            subtotal_vnd, tax_vnd, total_vnd, rule_set_version, created_by)
         values ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11)
         returning id`,
        [merchantId, orderId, profileId, KIND_ORIGINAL, JSON.stringify(seller), JSON.stringify(buyer),
         totals.subtotalVnd, totals.taxVnd, totals.totalVnd, RULE_SET_VERSION, userId]);
      const invoiceId = ins.rows[0].id;
      await insertItems(client, merchantId, invoiceId, lines);

      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "e_invoice.draft_created",
        entityType: "e_invoice", entityId: invoiceId,
        after: { orderId, ruleSetVersion: RULE_SET_VERSION, sellerReady: Boolean(seller.taxCode) },
      });
      await enqueueOutbox(client, {
        merchantId, eventType: "e_invoice.draft_created", aggregateId: invoiceId, payload: { orderId },
      });
      return { invoice: await loadInvoiceAggregate(client, merchantId, invoiceId), existing: false };
    }));
  return { ...result, replayed };
}

// ── Buyer autosave ───────────────────────────────────────────────────────────

/** PATCH /e-invoices/:id/buyer — autosave buyer snapshot with If-Match (spec 3.4, 10.4). */
export async function updateBuyer(merchantId, userId, invoiceId, buyer, ifMatchVersion) {
  return withTransaction(async (client) => {
    const inv = await client.query(`select * from public.e_invoices where id=$1 and merchant_id=$2 for update`, [invoiceId, merchantId]);
    if (!inv.rows.length) fail("INVOICE_NOT_FOUND");
    const row = mapInvoiceRow(inv.rows[0]);
    if (!isEditable(row.status)) fail("INVOICE_NOT_EDITABLE");
    if (ifMatchVersion != null && row.rowVersion !== Number(ifMatchVersion)) {
      throw new DomainError("VERSION_CONFLICT", undefined, { current: { rowVersion: row.rowVersion } });
    }
    const next = {
      kind: buyer.kind === "organization" ? "organization" : "individual",
      name: buyer.name != null ? String(buyer.name).trim() || null : null,
      taxCode: buyer.taxCode != null ? normalizeTaxId(buyer.taxCode) || null : null,
      address: buyer.address != null ? String(buyer.address).trim() || null : null,
      email: buyer.email != null ? String(buyer.email).trim() || null : null,
    };
    // A buyer edit invalidates any prior server preview → drop back to draft, clear hash.
    const nextStatus = row.status === "validated" || row.status === "validation_failed" ? "draft" : row.status;
    await client.query(
      `update public.e_invoices set buyer_snapshot=$1, status=$2, payload_hash=null, row_version=row_version+1 where id=$3`,
      [JSON.stringify(next), nextStatus, invoiceId]);
    return loadInvoiceAggregate(client, merchantId, invoiceId);
  });
}

// ── Validate ─────────────────────────────────────────────────────────────────

/** A short-lived server-preview token bound to invoice+version+hash (spec 10.2). */
function validationTokenFor(invoiceId, rowVersion, payloadHash) {
  return deterministicUuid(`einvoice-token:${invoiceId}:${rowVersion}:${payloadHash}`);
}

/**
 * POST /e-invoices/:id/validate — server recompute + rule check (spec 3.5, INV-03/04/05).
 * Recomputes totals from the CURRENT order (never trusts client/AI), runs seller/
 * buyer/line validation, then either marks validation_failed (with readable errors)
 * or validated (with the canonical payload_hash set). Idempotent by nature.
 */
export async function validateInvoice(merchantId, userId, invoiceId, expectedVersion) {
  return withTransaction(async (client) => {
    const inv = await client.query(`select * from public.e_invoices where id=$1 and merchant_id=$2 for update`, [invoiceId, merchantId]);
    if (!inv.rows.length) fail("INVOICE_NOT_FOUND");
    const row = mapInvoiceRow(inv.rows[0]);
    if (!isEditable(row.status)) fail("INVOICE_NOT_EDITABLE");
    if (expectedVersion != null && row.rowVersion !== Number(expectedVersion)) {
      throw new DomainError("VERSION_CONFLICT", undefined, { current: { rowVersion: row.rowVersion } });
    }

    // Server-authoritative recompute from the live order (INV-03: client total ignored).
    const { lines, totals } = await orderLinesFor(client, row.orderId);
    // Re-sync the frozen item rows so the preview reflects the current order.
    await client.query(`delete from public.e_invoice_items where invoice_id=$1`, [invoiceId]);
    await insertItems(client, merchantId, invoiceId, lines);

    const seller = row.sellerSnapshot;
    const buyer = row.buyerSnapshot;
    const { ok, errors } = runValidation({ seller, buyer, lines });

    if (!ok) {
      await client.query(
        `update public.e_invoices set status='validation_failed', subtotal_vnd=$1, tax_vnd=$2, total_vnd=$3, payload_hash=null, row_version=row_version+1 where id=$4`,
        [totals.subtotalVnd, totals.taxVnd, totals.totalVnd, invoiceId]);
      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "e_invoice.validated",
        entityType: "e_invoice", entityId: invoiceId,
        after: { ok: false, ruleSetVersion: row.ruleSetVersion, errorCodes: errors.map((e) => e.code), totals },
      });
      const invoice = await loadInvoiceAggregate(client, merchantId, invoiceId);
      return { ok: false, errors, invoice };
    }

    const canonicalPayload = buildCanonicalPayload({
      ruleSetVersion: row.ruleSetVersion, invoiceKind: row.invoiceKind, seller, buyer, lines, totals,
    });
    const payloadHash = payloadHashOf(canonicalPayload);
    const upd = await client.query(
      `update public.e_invoices set status='validated', subtotal_vnd=$1, tax_vnd=$2, total_vnd=$3, payload_hash=$4, row_version=row_version+1 where id=$5 returning row_version`,
      [totals.subtotalVnd, totals.taxVnd, totals.totalVnd, payloadHash, invoiceId]);
    const newVersion = Number(upd.rows[0].row_version);
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "e_invoice.validated",
      entityType: "e_invoice", entityId: invoiceId,
      after: { ok: true, ruleSetVersion: row.ruleSetVersion, payloadHash, totals },
    });
    const invoice = await loadInvoiceAggregate(client, merchantId, invoiceId);
    return { ok: true, errors: [], invoice, validationToken: validationTokenFor(invoiceId, newVersion, payloadHash), expectedVersion: newVersion };
  });
}

// ── Submit (freeze + enqueue) ────────────────────────────────────────────────

/**
 * POST /e-invoices/:id/submit — the freeze-and-enqueue transaction (spec 9.3, INV-06).
 * Within ONE tx: lock the invoice, verify it is validated + current + acknowledged,
 * re-verify the payload hash against the live order (INV-09), insert the submission
 * with a DETERMINISTIC client_request_id (so a double-tap of the same version dedupes
 * to ONE submission — spec 5.1), flip to submitting, enqueue outbox. The provider
 * network call runs AFTER commit.
 */
export async function submitInvoice(merchantId, userId, invoiceId, body, idemKey) {
  if (!idemKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const ack = body?.acknowledgements || {};
  if (!(ack.buyer_reviewed === true && ack.amounts_reviewed === true)) fail("ACKNOWLEDGEMENT_REQUIRED");

  const frozen = await withTransaction(async (client) => {
    const inv = await client.query(`select * from public.e_invoices where id=$1 and merchant_id=$2 for update`, [invoiceId, merchantId]);
    if (!inv.rows.length) fail("INVOICE_NOT_FOUND");
    const row = mapInvoiceRow(inv.rows[0]);

    // Replay: already frozen/decided → return the current submission, no double-send.
    if (row.status === "submitting" || row.status === "accepted") {
      const sub = await client.query(`select id from public.e_invoice_submissions where invoice_id=$1 order by attempt_no desc limit 1`, [invoiceId]);
      return { invoiceId, status: row.status, submissionId: sub.rows[0]?.id ?? null, replayed: true, providerCall: false };
    }
    if (row.status !== "validated") fail("INVOICE_NOT_VALIDATED");
    if (body?.expectedVersion != null && row.rowVersion !== Number(body.expectedVersion)) {
      throw new DomainError("VERSION_CONFLICT", undefined, { current: { rowVersion: row.rowVersion } });
    }

    // Re-verify integrity against the live order (INV-09: order changed before freeze).
    const items = await client.query(`select * from public.e_invoice_items where invoice_id=$1 order by id`, [invoiceId]);
    const lines = items.rows.map((r) => ({
      orderItemId: r.order_item_id, description: r.description, unit: r.unit, quantity: Number(r.quantity),
      unitPriceVnd: Number(r.unit_price_vnd), taxCode: r.tax_code, taxRate: Number(r.tax_rate),
      lineTotalVnd: Number(r.line_total_vnd), taxVnd: Number(r.tax_vnd),
    }));
    const totals = { subtotalVnd: row.subtotalVnd, taxVnd: row.taxVnd, totalVnd: row.totalVnd };
    const recomputed = payloadHashOf(buildCanonicalPayload({
      ruleSetVersion: row.ruleSetVersion, invoiceKind: row.invoiceKind,
      seller: row.sellerSnapshot, buyer: row.buyerSnapshot, lines, totals,
    }));
    if (!row.payloadHash || row.payloadHash !== recomputed) {
      throw new DomainError("VERSION_CONFLICT", "Nội dung hóa đơn đã đổi. Vui lòng kiểm tra lại.", { action: "REVALIDATE" });
    }

    // Deterministic client_request_id → durable idempotency for the transport (spec 5.1).
    const clientRequestId = `soho-${invoiceId}-${row.rowVersion}`;
    const attemptRes = await client.query(`select coalesce(max(attempt_no),0)+1 as n from public.e_invoice_submissions where invoice_id=$1`, [invoiceId]);
    const attemptNo = Number(attemptRes.rows[0].n);

    const subIns = await client.query(
      `insert into public.e_invoice_submissions (merchant_id, invoice_id, attempt_no, client_request_id, status, request_hash, provider_code)
       values ($1,$2,$3,$4,'queued',$5,$6)
       on conflict (client_request_id) do nothing
       returning id`,
      [merchantId, invoiceId, attemptNo, clientRequestId, row.payloadHash, PROVIDER_CODE]);

    let submissionId;
    if (subIns.rows.length === 0) {
      // Same version already has a submission → concurrent double-tap: replay it.
      const ex = await client.query(`select id from public.e_invoice_submissions where client_request_id=$1`, [clientRequestId]);
      submissionId = ex.rows[0]?.id ?? null;
      return { invoiceId, status: "submitting", submissionId, replayed: true, providerCall: false };
    }
    submissionId = subIns.rows[0].id;

    await client.query(`update public.e_invoices set status='submitting', row_version=row_version+1 where id=$1`, [invoiceId]);
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "e_invoice.submitted",
      entityType: "e_invoice", entityId: invoiceId,
      after: { submissionId, clientRequestId, payloadHash: row.payloadHash, provider: PROVIDER_CODE },
    });
    await enqueueOutbox(client, { merchantId, eventType: "e_invoice.submit_requested", aggregateId: invoiceId, payload: { submissionId } });
    return { invoiceId, status: "submitting", submissionId, clientRequestId, payloadHash: row.payloadHash, replayed: false, providerCall: true };
  });

  // ── Post-commit provider call (spec 9.3: never during the DB transaction). ──
  if (frozen.providerCall && frozen.submissionId) {
    try {
      const provider = getProvider(PROVIDER_CODE) || MockProvider;
      const resp = provider.createSubmission({
        invoiceId, payloadHash: frozen.payloadHash, clientRequestId: frozen.clientRequestId,
      });
      await query(
        `update public.e_invoice_submissions set status='sent', response_hash=$1, provider_message=$2, submitted_at=now() where id=$3`,
        [resp.responseHash, resp.message || null, frozen.submissionId]);
      // Record the provider tracking ref so a webhook can resolve this invoice.
      await query(`update public.e_invoices set provider_invoice_ref=$1 where id=$2 and provider_invoice_ref is null`, [resp.providerRef, invoiceId]);
    } catch (err) {
      // Transport failure: leave the submission 'queued' for reconcile; do NOT fail the
      // request (the invoice is safely 'submitting'; INV-07 reconcile handles the rest).
      await query(`update public.e_invoice_submissions set status='failed', provider_message=$1 where id=$2`, [String(err?.message || "provider error"), frozen.submissionId]).catch(() => {});
    }
  }
  return { invoiceId, submissionId: frozen.submissionId, status: frozen.status, replayed: frozen.replayed };
}

// ── Status / reconcile ───────────────────────────────────────────────────────

/** GET /e-invoices/:id/status — reconcile view (spec 3.7, 10). */
export async function getStatus(merchantId, invoiceId, { reconcile = false } = {}) {
  const invoice = await loadInvoiceAggregate(getPool(), merchantId, invoiceId);
  if (reconcile && invoice.status === "submitting") {
    // The mock holds no async state; a real adapter would poll here. State only ever
    // advances via a verified event, so reconcile is a safe no-op for the mock.
    const provider = getProvider(invoice.submissions[0]?.providerCode || PROVIDER_CODE) || MockProvider;
    provider.getStatus(invoice.providerInvoiceRef);
  }
  return {
    id: invoice.id, status: invoice.status, providerInvoiceRef: invoice.providerInvoiceRef,
    rowVersion: invoice.rowVersion, submissions: invoice.submissions, events: invoice.events,
  };
}

// ── Provider events (webhook + dev simulate) ─────────────────────────────────

/** Map a raw provider reject code to a readable Vietnamese line (spec 3.7, 11 AI-free). */
const REJECT_MESSAGES = {
  BUYER_TAX_ID_INVALID: "Mã số thuế người mua không hợp lệ theo nhà cung cấp.",
  SELLER_NOT_REGISTERED: "Người bán chưa đăng ký phát hành với nhà cung cấp.",
  DUPLICATE_INVOICE: "Nhà cung cấp báo trùng hóa đơn.",
  TEMPLATE_NOT_ALLOWED: "Mẫu/ký hiệu chưa được nhà cung cấp cho phép.",
};
export function rejectMessageFor(code) {
  return REJECT_MESSAGES[code] || "Hóa đơn bị từ chối. Vui lòng kiểm tra thông tin và gửi lại.";
}

/**
 * The provider-event boundary (spec 9.4, INV-07/08/10). Verifies the signature,
 * dedupes on (provider_code, provider_event_id), and only a signature-valid, in-order
 * event drives the state reducer. Duplicate events append nothing new; an invalid
 * signature never changes state. Idempotent.
 * @returns {Promise<{processed, duplicated, signatureValid, status}>}
 */
export async function processProviderEvent({ providerCode, rawBody, signature }) {
  const provider = getProvider(providerCode);
  if (!provider) fail("PROVIDER_NOT_CONFIGURED");
  const signatureValid = provider.verifySignature(rawBody, signature);

  let event;
  try { event = JSON.parse(rawBody); } catch { fail("WEBHOOK_INVALID", "Payload không hợp lệ."); }
  const providerEventId = event.providerEventId || event.provider_event_id;
  const eventType = event.eventType || event.event_type;
  const occurredAt = event.occurredAt || event.occurred_at || null;
  if (!providerEventId || !eventType) fail("WEBHOOK_INVALID", "Thiếu trường sự kiện.");
  const payloadHash = event.payloadHash || event.payload_hash || null;

  return withTransaction(async (client) => {
    // Resolve the invoice by the trusted provider reference or the carried invoice id.
    let invoiceRow = null;
    const providerRef = event.providerRef || event.provider_ref || null;
    if (providerRef) {
      const r = await client.query(`select * from public.e_invoices where provider_invoice_ref=$1 limit 1`, [providerRef]);
      invoiceRow = r.rows[0] || null;
    }
    if (!invoiceRow && (event.invoiceId || event.invoice_id)) {
      const r = await client.query(`select * from public.e_invoices where id=$1`, [event.invoiceId || event.invoice_id]);
      invoiceRow = r.rows[0] || null;
    }
    const invoiceId = invoiceRow ? invoiceRow.id : null;

    // Insert the event; the unique index makes a replay a no-op (INV-08).
    const evIns = await client.query(
      `insert into public.e_invoice_provider_events
         (provider_code, provider_event_id, invoice_id, event_type, occurred_at, signature_valid, payload_hash)
       values ($1,$2,$3,$4,coalesce($5::timestamptz, now()),$6,$7)
       on conflict (provider_code, provider_event_id) do nothing
       returning id`,
      [providerCode, providerEventId, invoiceId, eventType, occurredAt, signatureValid, payloadHash || ""]);
    if (evIns.rows.length === 0) {
      return { processed: false, duplicated: true, signatureValid, status: invoiceRow?.status ?? null };
    }

    // Invalid signature: recorded for the security audit, but NEVER changes state (INV-07).
    if (!signatureValid) {
      await client.query(`update public.e_invoice_provider_events set processed_at=now() where id=$1`, [evIns.rows[0].id]);
      if (invoiceId) {
        await writeAudit(client, {
          merchantId: invoiceRow.merchant_id, actorUserId: null, action: "e_invoice.provider_event",
          entityType: "e_invoice", entityId: invoiceId,
          after: { providerEventId, eventType, signatureValid: false, rejected: true },
        });
      }
      return { processed: false, duplicated: false, signatureValid: false, status: invoiceRow?.status ?? null };
    }
    if (!invoiceId) {
      await client.query(`update public.e_invoice_provider_events set processed_at=now() where id=$1`, [evIns.rows[0].id]);
      return { processed: false, duplicated: false, signatureValid: true, status: null };
    }

    // Lock the invoice + apply the reducer (terminal/out-of-order guarded).
    const locked = await client.query(`select * from public.e_invoices where id=$1 for update`, [invoiceId]);
    const inv = mapInvoiceRow(locked.rows[0]);
    const prior = await client.query(
      `select max(occurred_at) as last from public.e_invoice_provider_events where invoice_id=$1 and id<>$2 and signature_valid=true`,
      [invoiceId, evIns.rows[0].id]);
    const next = reduceProviderEvent(inv.status, eventType, occurredAt, prior.rows[0]?.last || null);

    let newStatus = inv.status;
    if (next && next !== inv.status) {
      newStatus = next;
      await client.query(`update public.e_invoices set status=$1, row_version=row_version+1 where id=$2`, [next, invoiceId]);
      if (next === "rejected") {
        const rejCode = event.providerCode2 || event.reject_code || event.code || null;
        await client.query(
          `update public.e_invoice_submissions set status='failed', provider_message=$1
            where invoice_id=$2 and attempt_no=(select max(attempt_no) from public.e_invoice_submissions where invoice_id=$2)`,
          [rejCode ? `${rejCode}` : "REJECTED", invoiceId]);
      }
      if (next === "accepted") {
        // Close a correction chain: if this accepted invoice replaces/adjusts an
        // original, move the original to replaced/adjusted (spec 4.3, INV-13).
        const rel = await client.query(
          `select original_invoice_id, relation_type from public.e_invoice_relations
            where related_invoice_id=$1 and relation_type in ('adjustment','replacement') limit 1`, [invoiceId]);
        if (rel.rows.length) {
          const parentStatus = rel.rows[0].relation_type === "replacement" ? "replaced" : "adjusted";
          await client.query(`update public.e_invoices set status=$1, row_version=row_version+1 where id=$2 and status='accepted'`, [parentStatus, rel.rows[0].original_invoice_id]);
        }
      }
      await writeAudit(client, {
        merchantId: inv.merchantId, actorUserId: null,
        action: next === "accepted" ? "e_invoice.accepted" : "e_invoice.provider_event",
        entityType: "e_invoice", entityId: invoiceId,
        after: { providerEventId, eventType, signatureValid: true, from: inv.status, to: next },
      });
      await enqueueOutbox(client, { merchantId: inv.merchantId, eventType: `e_invoice.${next}`, aggregateId: invoiceId, payload: { providerEventId } });
    }
    await client.query(`update public.e_invoice_provider_events set processed_at=now() where id=$1`, [evIns.rows[0].id]);
    return { processed: true, duplicated: false, signatureValid: true, status: newStatus };
  });
}

/** Dev-only: build a signed event and drive processProviderEvent (mirrors a webhook). */
export async function simulateProviderDecision(merchantId, { invoiceId, decision, rejectCode, eventId }) {
  const inv = await query(`select provider_invoice_ref, merchant_id, status from public.e_invoices where id=$1 and merchant_id=$2`, [invoiceId, merchantId]);
  if (!inv.rows.length) fail("INVOICE_NOT_FOUND");
  const eventType = decision === "reject" || decision === "rejected" ? "rejected" : "accepted";
  const event = {
    providerEventId: eventId || `SIM-${invoiceId}-${eventType}`,
    invoiceId,
    providerRef: inv.rows[0].provider_invoice_ref || undefined,
    eventType,
    occurredAt: new Date().toISOString(),
    providerCode: PROVIDER_CODE,
    reject_code: eventType === "rejected" ? (rejectCode || "BUYER_TAX_ID_INVALID") : undefined,
  };
  const rawBody = JSON.stringify(event);
  const signature = MockProvider.signEvent(event);
  return processProviderEvent({ providerCode: PROVIDER_CODE, rawBody, signature });
}

// ── Rejected retry + relations ───────────────────────────────────────────────

/** Clone a rejected invoice into a fresh draft (spec 3.7/4.3, INV-12). Original kept. */
export async function retryDraft(merchantId, userId, invoiceId, idemKey) {
  if (!idemKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const { result, replayed } = await runIdempotent("einvoice-retry", idemKey, bodyHash({ invoiceId }), async () =>
    withTransaction(async (client) => {
      const src = await client.query(`select * from public.e_invoices where id=$1 and merchant_id=$2 for update`, [invoiceId, merchantId]);
      if (!src.rows.length) fail("INVOICE_NOT_FOUND");
      const orig = mapInvoiceRow(src.rows[0]);
      if (!canRetry(orig.status)) fail("RELATION_NOT_ALLOWED", "Chỉ hóa đơn bị từ chối mới có thể tạo bản gửi lại.");

      const { lines, totals } = await orderLinesFor(client, orig.orderId);
      const profileId = deterministicUuid(`einvoice-profile:${merchantId}`);
      const ins = await client.query(
        `insert into public.e_invoices
           (merchant_id, order_id, profile_id, invoice_kind, status, seller_snapshot, buyer_snapshot,
            subtotal_vnd, tax_vnd, total_vnd, rule_set_version, created_by)
         values ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11) returning id`,
        [merchantId, orig.orderId, profileId, KIND_ORIGINAL, JSON.stringify(orig.sellerSnapshot),
         JSON.stringify(orig.buyerSnapshot), totals.subtotalVnd, totals.taxVnd, totals.totalVnd, RULE_SET_VERSION, userId]);
      const newId = ins.rows[0].id;
      await insertItems(client, merchantId, newId, lines);
      await client.query(
        `insert into public.e_invoice_relations (merchant_id, original_invoice_id, related_invoice_id, relation_type, reason, created_by)
         values ($1,$2,$3,'retry',$4,$5) on conflict do nothing`,
        [merchantId, invoiceId, newId, "Tạo lại sau khi bị từ chối", userId]);
      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "e_invoice.related",
        entityType: "e_invoice", entityId: invoiceId, after: { relationType: "retry", relatedInvoiceId: newId },
      });
      return { invoice: await loadInvoiceAggregate(client, merchantId, newId) };
    }));
  return { ...result, replayed };
}

/** Create an adjustment/replacement corrective draft for an accepted invoice (spec 4.3, INV-13). */
export async function createRelation(merchantId, userId, invoiceId, input, idemKey) {
  if (!idemKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const relationType = input.relationType === "replacement" ? "replacement" : "adjustment";
  const reason = String(input.reason || "").trim();
  if (!reason) fail("VALIDATION", "Vui lòng nhập lý do điều chỉnh/thay thế.");
  const { result, replayed } = await runIdempotent("einvoice-relation", idemKey, bodyHash({ invoiceId, relationType }), async () =>
    withTransaction(async (client) => {
      const src = await client.query(`select * from public.e_invoices where id=$1 and merchant_id=$2 for update`, [invoiceId, merchantId]);
      if (!src.rows.length) fail("INVOICE_NOT_FOUND");
      const orig = mapInvoiceRow(src.rows[0]);
      if (!canRelate(orig.status)) fail("INVOICE_NOT_ACCEPTED");

      const { lines, totals } = await orderLinesFor(client, orig.orderId);
      const profileId = deterministicUuid(`einvoice-profile:${merchantId}`);
      // invoice_kind = relationType so the (order, kind) partial-unique never clashes
      // with the still-active accepted 'sale' original.
      const ins = await client.query(
        `insert into public.e_invoices
           (merchant_id, order_id, profile_id, invoice_kind, status, seller_snapshot, buyer_snapshot,
            subtotal_vnd, tax_vnd, total_vnd, rule_set_version, created_by)
         values ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11) returning id`,
        [merchantId, orig.orderId, profileId, relationType, JSON.stringify(orig.sellerSnapshot),
         JSON.stringify(orig.buyerSnapshot), totals.subtotalVnd, totals.taxVnd, totals.totalVnd, RULE_SET_VERSION, userId]);
      const newId = ins.rows[0].id;
      await insertItems(client, merchantId, newId, lines);
      await client.query(
        `insert into public.e_invoice_relations (merchant_id, original_invoice_id, related_invoice_id, relation_type, reason, created_by)
         values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
        [merchantId, invoiceId, newId, relationType, reason, userId]);
      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "e_invoice.related",
        entityType: "e_invoice", entityId: invoiceId, after: { relationType, relatedInvoiceId: newId, reason },
      });
      return { invoice: await loadInvoiceAggregate(client, merchantId, newId), relationType };
    }));
  return { ...result, replayed };
}

// ── Artifacts ────────────────────────────────────────────────────────────────

/** GET /e-invoices/:id/artifacts/:type — mock XML/PDF from the frozen snapshot (INV-11). */
export async function getArtifact(merchantId, invoiceId, type) {
  const invoice = await loadInvoiceAggregate(getPool(), merchantId, invoiceId);
  if (invoice.status !== "accepted") fail("INVOICE_NOT_ACCEPTED", "Chỉ tải được tệp khi hóa đơn đã được chấp nhận.");
  const artifacts = MockProvider.buildArtifacts(invoice);
  const a = artifacts[type];
  if (!a) fail("ARTIFACT_NOT_FOUND");
  return a;
}
