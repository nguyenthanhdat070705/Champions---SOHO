// Functional 06 — purchase receipts: the write path that turns "hàng đã về" into
// stock + a pending accounting draft, atomically (spec 4.2 / 7.1 / 9.3). Design:
//   • Draft/review/ready receipts NEVER touch stock (REC-01). The SERVER always
//     recomputes line/subtotal/grand totals — a client/OCR total is advisory only
//     (REC-02 / REC-FR-06).
//   • Post is ONE transaction: recompute totals → one 'purchase_receipt' movement
//     per line (raises stock, locked in product_id order, spec 5.1) → exactly ONE
//     accounting_event (unique on source_type+source_id+event_type → REC-15) →
//     receipt→posted → audit + outbox. All-or-nothing (REC-03 / REC-04). Idempotent
//     per Idempotency-Key AND replayed via the movement/event unique indexes so a
//     retry never double-applies (REC-05).
//   • Posted is immutable (spec 4.2). A mistake is fixed by REVERSE, which appends
//     opposite 'reversal' movements + a 'reversed' event and never edits the row;
//     a reverse that would drive stock negative is BLOCKED (REC-08 / REC-12).
import { withTransaction, query, getPool } from "../db/pool.js";
import { DomainError, fail } from "../f3/errors.js";
import { writeAudit, enqueueOutbox } from "../f3/audit.js";
import { receiptNumber } from "../f3/numbering.js";
import { postMovementTx, round3, deterministicUuid, loadTrackedProduct } from "../f5/movements.js";
import { runIdempotent, bodyHash } from "../f5/idem.js";
import { computeTotals, lineTotal } from "./receiving-math.js";

const EDITABLE = ["draft", "review", "ready"];

// ── Mappers ──────────────────────────────────────────────────────────────────
/**
 * Format a Postgres `date` as 'YYYY-MM-DD' without a timezone shift. node-pg
 * parses a bare date into a JS Date at LOCAL midnight, so toISOString() would slew
 * it by the TZ offset — use the local calendar components instead.
 */
function dateOnly(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function mapReceipt(r) {
  return {
    id: r.id,
    receiptNumber: r.receipt_number,
    status: r.status,
    receivedAt: dateOnly(r.received_at),
    supplierId: r.supplier_id,
    supplierName: r.supplier_name_snapshot,
    documentId: r.document_id,
    documentNumber: r.document_number ?? null,
    subtotalVnd: Number(r.subtotal_vnd),
    extraCostVnd: Number(r.extra_cost_vnd),
    grandTotalVnd: Number(r.grand_total_vnd),
    rowVersion: Number(r.row_version),
    createdAt: r.created_at,
    postedAt: r.posted_at,
  };
}

function mapItem(r) {
  return {
    id: r.id,
    productId: r.product_id,
    name: r.name_snapshot,
    unitCode: r.unit_code_snapshot,
    quantity: round3(r.quantity),
    unitCostVnd: Number(r.unit_cost_vnd),
    lineTotalVnd: Number(r.line_total_vnd),
    matchSource: r.match_source,
    matchConfidence: r.match_confidence == null ? null : Number(r.match_confidence),
  };
}

async function loadReceiptRow(client, merchantId, receiptId, forUpdate = false) {
  const { rows } = await client.query(
    `select pr.*, sd.document_number
       from public.purchase_receipts pr
       left join public.source_documents sd on sd.id = pr.document_id
      where pr.id=$1 and pr.merchant_id=$2 ${forUpdate ? "for update of pr" : ""}`,
    [receiptId, merchantId],
  );
  if (rows.length === 0) fail("RECEIPT_NOT_FOUND");
  return rows[0];
}

async function loadItems(clientOrPool, merchantId, receiptId) {
  const { rows } = await clientOrPool.query(
    `select * from public.purchase_receipt_items
      where receipt_id=$1 and merchant_id=$2 order by product_id`,
    [receiptId, merchantId],
  );
  return rows;
}

// ── Validation helpers ───────────────────────────────────────────────────────
async function todayBusinessDate() {
  const { rows } = await query(`select to_char((now() at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') as d`);
  return rows[0].d; // 'YYYY-MM-DD' string
}

function normalizeReceivedAt(input, today) {
  const s = String(input || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail("VALIDATION", "Ngày nhận không hợp lệ.");
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) fail("VALIDATION", "Ngày nhận không hợp lệ.");
  // Not more than 1 day in the future (spec 3.3 "không quá xa tương lai").
  const t = new Date(`${String(today).slice(0, 10)}T00:00:00Z`);
  if (d.getTime() > t.getTime() + 24 * 3600 * 1000) fail("VALIDATION", "Ngày nhận không được ở tương lai.");
  return s;
}

async function resolveSupplier(merchantId, supplierId, supplierName) {
  if (supplierId) {
    const { rows } = await query(`select id, name from public.suppliers where id=$1 and merchant_id=$2`, [supplierId, merchantId]);
    if (rows.length === 0) fail("VALIDATION", "Nhà cung cấp không hợp lệ.");
    return { supplierId: rows[0].id, supplierName: rows[0].name };
  }
  const name = supplierName ? String(supplierName).trim().slice(0, 160) || null : null;
  return { supplierId: null, supplierName: name };
}

async function verifyDocument(merchantId, documentId) {
  if (!documentId) return null;
  const { rows } = await query(`select id from public.source_documents where id=$1 and merchant_id=$2`, [documentId, merchantId]);
  if (rows.length === 0) fail("DOCUMENT_NOT_FOUND");
  return documentId;
}

// ── Create / read / list ─────────────────────────────────────────────────────

/** POST /receiving/receipts — create a draft (no stock change, REC-01). */
export async function createReceipt(merchantId, userId, input = {}, idemKey) {
  const today = await todayBusinessDate(); // 'YYYY-MM-DD' string
  const receivedAt = normalizeReceivedAt(input.receivedAt || today, today);
  const { supplierId, supplierName } = await resolveSupplier(merchantId, input.supplierId, input.supplierName);
  const documentId = await verifyDocument(merchantId, input.documentId);
  const extraCostVnd = Math.max(0, Math.round(Number(input.extraCostVnd) || 0));

  const canonical = { receivedAt, supplierId, supplierName, documentId };
  const { result, replayed } = await runIdempotent("receipt-create", idemKey, bodyHash(canonical), async () => {
    // One source document links one primary receipt (spec 4.3): if a non-terminal
    // receipt already references this document, return it instead of a new draft.
    if (documentId) {
      const { rows } = await query(
        `select * from public.purchase_receipts
          where merchant_id=$1 and document_id=$2 and status = any($3::text[])
          order by created_at desc limit 1`,
        [merchantId, documentId, EDITABLE],
      );
      if (rows.length) return { receipt: mapReceipt({ ...rows[0], document_number: null }), items: [] };
    }
    const number = receiptNumber("PN", receivedAt);
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into public.purchase_receipts
           (merchant_id, receipt_number, status, received_at, supplier_id, supplier_name_snapshot, document_id, extra_cost_vnd, created_by)
         values ($1,$2,'draft',$3,$4,$5,$6,$7,$8)
         returning *`,
        [merchantId, number, receivedAt, supplierId, supplierName, documentId, extraCostVnd, userId],
      );
      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "receipt.created",
        entityType: "purchase_receipt", entityId: rows[0].id,
        after: { receiptNumber: number, receivedAt, supplierName, documentId },
      });
      return { receipt: mapReceipt({ ...rows[0], document_number: null }), items: [] };
    });
  });
  return { ...result, replayed };
}

/** GET /receiving/receipts/:id — header + items (+ accounting/movements if posted). */
export async function getReceipt(merchantId, receiptId) {
  const pool = getPool();
  const r = await loadReceiptRow(pool, merchantId, receiptId);
  const items = await loadItems(pool, merchantId, receiptId);
  const receipt = mapReceipt(r);

  let accounting = null;
  const acc = await pool.query(
    `select id, event_type, amount_vnd, review_status, created_at
       from public.accounting_events
      where merchant_id=$1 and source_type='purchase_receipt' and source_id=$2
      order by created_at`,
    [merchantId, receiptId],
  );
  if (acc.rows.length) {
    accounting = acc.rows.map((a) => ({
      id: a.id, eventType: a.event_type, amountVnd: Number(a.amount_vnd),
      reviewStatus: a.review_status, createdAt: a.created_at,
    }));
  }

  let movements = null;
  if (r.status === "posted" || r.status === "reversed") {
    const mv = await pool.query(
      `select m.id, m.product_id, m.movement_type, m.quantity_delta, m.balance_after, m.created_at,
              p.name as product_name
         from public.inventory_movements m
         join public.products p on p.id = m.product_id
        where m.merchant_id=$1 and (
              (m.reference_type='purchase_receipt' and m.reference_id=$2)
           or (m.movement_type='reversal' and m.original_movement_id in (
                 select id from public.inventory_movements
                  where merchant_id=$1 and reference_type='purchase_receipt' and reference_id=$2)))
        order by m.created_at, m.product_id`,
      [merchantId, receiptId],
    );
    movements = mv.rows.map((m) => ({
      id: m.id, productId: m.product_id, productName: m.product_name,
      movementType: m.movement_type, quantityDelta: round3(m.quantity_delta),
      balanceAfter: round3(m.balance_after), createdAt: m.created_at,
    }));
  }

  return { receipt, items: items.map(mapItem), accounting, movements };
}

/** GET /receiving/receipts — list with status filter + supplier/number search. */
export async function listReceipts(merchantId, { status, search, limit } = {}) {
  const lim = Math.min(Math.max(1, Number(limit) || 40), 100);
  const params = [merchantId];
  let where = "pr.merchant_id=$1";
  if (status && status !== "all") {
    if (status === "draft") { where += ` and pr.status = any($${params.length + 1}::text[])`; params.push(["draft", "review", "ready", "extracting"]); }
    else { params.push(status); where += ` and pr.status=$${params.length}`; }
  }
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim().toLowerCase()}%`);
    where += ` and (lower(pr.receipt_number) like $${params.length} or lower(coalesce(pr.supplier_name_snapshot,'')) like $${params.length})`;
  }
  params.push(lim);
  const { rows } = await query(
    `select pr.*, null::text as document_number,
            (select count(*) from public.purchase_receipt_items i where i.receipt_id=pr.id)::int as item_count
       from public.purchase_receipts pr
      where ${where}
      order by pr.created_at desc
      limit $${params.length}`,
    params,
  );
  return { receipts: rows.map((r) => ({ ...mapReceipt(r), itemCount: r.item_count })) };
}

// ── Edit header / lines (draft/review/ready only) ────────────────────────────

/** PATCH /receiving/receipts/:id — edit header while still editable. */
export async function updateReceipt(merchantId, userId, receiptId, patch = {}, ifMatch) {
  // Validate the date OUTSIDE the row lock (no need to hold FOR UPDATE across it).
  const today = patch.receivedAt != null ? await todayBusinessDate() : null;
  return withTransaction(async (client) => {
    const r = await loadReceiptRow(client, merchantId, receiptId, true);
    if (!EDITABLE.includes(r.status)) fail("RECEIPT_INVALID_STATE");
    if (ifMatch != null && Number(r.row_version) !== Number(ifMatch)) fail("VERSION_CONFLICT");

    const receivedAt = patch.receivedAt != null ? normalizeReceivedAt(patch.receivedAt, today) : dateOnly(r.received_at);
    let supplierId = r.supplier_id, supplierName = r.supplier_name_snapshot;
    if (patch.supplierId !== undefined || patch.supplierName !== undefined) {
      const resolved = await resolveSupplier(merchantId, patch.supplierId, patch.supplierName);
      supplierId = resolved.supplierId; supplierName = resolved.supplierName;
    }
    const documentId = patch.documentId !== undefined ? await verifyDocument(merchantId, patch.documentId) : r.document_id;
    const extraCostVnd = patch.extraCostVnd != null ? Math.max(0, Math.round(Number(patch.extraCostVnd) || 0)) : Number(r.extra_cost_vnd);

    // Recompute grand_total if extra cost changed.
    const subtotal = Number(r.subtotal_vnd);
    const grand = subtotal + extraCostVnd;
    const { rows } = await client.query(
      `update public.purchase_receipts
          set received_at=$1, supplier_id=$2, supplier_name_snapshot=$3, document_id=$4,
              extra_cost_vnd=$5, grand_total_vnd=$6, row_version=row_version+1
        where id=$7 returning *`,
      [receivedAt, supplierId, supplierName, documentId, extraCostVnd, grand, receiptId],
    );
    return { receipt: mapReceipt({ ...rows[0], document_number: null }) };
  });
}

/** PUT /receiving/receipts/:id/items — replace the full line set + recompute. */
export async function putItems(merchantId, userId, receiptId, input = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  return withTransaction(async (client) => {
    const r = await loadReceiptRow(client, merchantId, receiptId, true);
    if (!EDITABLE.includes(r.status)) fail("RECEIPT_INVALID_STATE");
    if (input.expectedRowVersion != null && Number(r.row_version) !== Number(input.expectedRowVersion)) {
      fail("VERSION_CONFLICT", "Phiếu vừa được cập nhật ở nơi khác.");
    }

    // Validate + snapshot each line; reject duplicate products (spec 4.3 default).
    const seen = new Set();
    const prepared = [];
    for (const it of items) {
      if (!it || !it.productId) fail("VALIDATION", "Thiếu sản phẩm cho dòng hàng.");
      if (seen.has(it.productId)) fail("RECEIPT_DUPLICATE_PRODUCT", undefined, { productId: it.productId });
      seen.add(it.productId);
      const prod = await loadTrackedProduct(client, merchantId, it.productId); // goods + track_inventory or 422
      const quantity = round3(it.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) fail("VALIDATION", "Số lượng phải lớn hơn 0.");
      const unitCostVnd = Math.round(Number(it.unitCostVnd));
      if (!Number.isFinite(unitCostVnd) || unitCostVnd < 0) fail("VALIDATION", "Đơn giá không hợp lệ.");
      const matchSource = ["manual", "ai", "barcode"].includes(it.matchSource) ? it.matchSource : "manual";
      const matchConfidence = it.matchConfidence != null && Number.isFinite(Number(it.matchConfidence))
        ? Math.max(0, Math.min(1, Number(it.matchConfidence))) : null;
      prepared.push({
        productId: it.productId, name: prod.name, unitCode: prod.unit_code,
        quantity, unitCostVnd, lineTotalVnd: lineTotal(quantity, unitCostVnd), matchSource, matchConfidence,
      });
    }

    await client.query(`delete from public.purchase_receipt_items where receipt_id=$1 and merchant_id=$2`, [receiptId, merchantId]);
    for (const p of prepared) {
      await client.query(
        `insert into public.purchase_receipt_items
           (merchant_id, receipt_id, product_id, name_snapshot, unit_code_snapshot, quantity, unit_cost_vnd, line_total_vnd, match_source, match_confidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [merchantId, receiptId, p.productId, p.name, p.unitCode, p.quantity, p.unitCostVnd, p.lineTotalVnd, p.matchSource, p.matchConfidence],
      );
    }

    const totals = computeTotals(prepared, Number(r.extra_cost_vnd));
    const nextStatus = prepared.length > 0 ? "review" : "draft";
    const { rows } = await client.query(
      `update public.purchase_receipts
          set subtotal_vnd=$1, grand_total_vnd=$2, status=$3, row_version=row_version+1
        where id=$4 returning *`,
      [totals.subtotalVnd, totals.grandTotalVnd, nextStatus, receiptId],
    );
    const fresh = await loadItems(client, merchantId, receiptId);
    return { receipt: mapReceipt({ ...rows[0], document_number: null }), items: fresh.map(mapItem) };
  });
}

// ── Preview → Post → Cancel → Reverse ────────────────────────────────────────

/** POST /receiving/receipts/:id/preview — recompute totals + per-line stock impact. */
export async function previewReceipt(merchantId, userId, receiptId) {
  return withTransaction(async (client) => {
    const r = await loadReceiptRow(client, merchantId, receiptId, true);
    if (!EDITABLE.includes(r.status)) fail("RECEIPT_INVALID_STATE");
    const items = await loadItems(client, merchantId, receiptId);
    if (items.length === 0) fail("RECEIPT_NO_LINES");

    const totals = computeTotals(items.map((i) => ({ quantity: i.quantity, unitCostVnd: Number(i.unit_cost_vnd) })), Number(r.extra_cost_vnd));

    const lines = [];
    for (const it of items) {
      const lvl = await client.query(
        `select coalesce(on_hand,0) as on_hand, coalesce(row_version,1) as row_version
           from public.inventory_levels where merchant_id=$1 and product_id=$2`,
        [merchantId, it.product_id],
      );
      const before = lvl.rows.length ? round3(lvl.rows[0].on_hand) : 0;
      const delta = round3(it.quantity);
      lines.push({
        productId: it.product_id, name: it.name_snapshot, unitCode: it.unit_code_snapshot,
        quantity: round3(it.quantity), unitCostVnd: Number(it.unit_cost_vnd), lineTotalVnd: Number(it.line_total_vnd),
        before, delta, after: round3(before + delta),
        levelVersion: lvl.rows.length ? Number(lvl.rows[0].row_version) : 1,
      });
    }

    const { rows } = await client.query(
      `update public.purchase_receipts
          set subtotal_vnd=$1, grand_total_vnd=$2, status='ready', row_version=row_version+1
        where id=$3 returning *`,
      [totals.subtotalVnd, totals.grandTotalVnd, receiptId],
    );
    return {
      receipt: mapReceipt({ ...rows[0], document_number: r.document_number }),
      lines,
      totals,
      accountingPreview: { eventType: "purchase_received", amountVnd: totals.grandTotalVnd, reviewStatus: "pending" },
    };
  });
}

/**
 * POST /receiving/receipts/:id/post — the atomic commit (spec 7.1, REC-03/04/05).
 * Idempotent: a same-key retry replays; the movement + accounting unique indexes
 * make a replay a no-op even across a restart.
 */
export async function postReceipt(merchantId, userId, role, receiptId, input = {}, idemKey) {
  if (!idemKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const { result, replayed } = await runIdempotent("receipt-post", idemKey, bodyHash({ receiptId }), async () => {
    return withTransaction(async (client) => {
      const r = await loadReceiptRow(client, merchantId, receiptId, true);
      if (r.status === "posted") return buildPostResult(client, merchantId, r, true);
      if (r.status === "cancelled" || r.status === "reversed") fail("RECEIPT_INVALID_STATE");
      if (input.expectedReceiptVersion != null && Number(r.row_version) !== Number(input.expectedReceiptVersion)) {
        fail("VERSION_CONFLICT", "Phiếu vừa được cập nhật. Vui lòng kiểm tra lại.");
      }

      const items = await loadItems(client, merchantId, receiptId); // product_id order (spec 5.1)
      if (items.length === 0) fail("RECEIPT_NO_LINES");

      // Recompute totals from the lines — never trust a stored/sent total (REC-02).
      const totals = computeTotals(items.map((i) => ({ quantity: i.quantity, unitCostVnd: Number(i.unit_cost_vnd) })), Number(r.extra_cost_vnd));

      const movements = [];
      for (const it of items) {
        const posted = await postMovementTx(client, {
          merchantId, productId: it.product_id, movementType: "purchase_receipt",
          delta: round3(it.quantity), referenceType: "purchase_receipt", referenceId: receiptId,
          sourceLineId: it.id, userId,
        });
        movements.push({ productId: it.product_id, movementId: posted.movementId, delta: round3(it.quantity), before: posted.previousBalance, after: posted.balanceAfter });
      }

      // Exactly ONE accounting event (REC-FR-09 / REC-15). Unique index dedupes.
      const acc = await client.query(
        `insert into public.accounting_events (merchant_id, source_type, source_id, event_type, amount_vnd, review_status)
         values ($1,'purchase_receipt',$2,'purchase_received',$3,'pending')
         on conflict (source_type, source_id, event_type) do nothing
         returning id`,
        [merchantId, receiptId, totals.grandTotalVnd],
      );
      let accountingEventId = acc.rows[0]?.id ?? null;
      if (!accountingEventId) {
        const ex = await client.query(
          `select id from public.accounting_events where source_type='purchase_receipt' and source_id=$1 and event_type='purchase_received'`,
          [receiptId],
        );
        accountingEventId = ex.rows[0]?.id ?? null;
      }

      const { rows: upd } = await client.query(
        `update public.purchase_receipts
            set status='posted', posted_by=$2, posted_at=now(),
                subtotal_vnd=$3, grand_total_vnd=$4, row_version=row_version+1
          where id=$1 returning *`,
        [receiptId, userId, totals.subtotalVnd, totals.grandTotalVnd],
      );

      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "receipt.posted",
        entityType: "purchase_receipt", entityId: receiptId,
        after: { receiptNumber: r.receipt_number, grandTotalVnd: totals.grandTotalVnd, lines: movements.length, accountingEventId },
      });
      await enqueueOutbox(client, {
        merchantId, eventType: "purchase_receipt.posted", aggregateId: receiptId,
        payload: { receiptId, grandTotalVnd: totals.grandTotalVnd, accountingEventId },
      });

      return {
        receiptId, receiptNumber: r.receipt_number, status: "posted",
        subtotalVnd: totals.subtotalVnd, grandTotalVnd: totals.grandTotalVnd,
        movements, accountingEventId, rowVersion: Number(upd[0].row_version), replayed: false,
      };
    });
  });
  return { ...result, replayed };
}

/** Rebuild a post-result for an idempotent replay (already-posted receipt). */
async function buildPostResult(client, merchantId, r, replayed) {
  const mv = await client.query(
    `select product_id, id as movement_id, quantity_delta, balance_after from public.inventory_movements
      where merchant_id=$1 and reference_type='purchase_receipt' and reference_id=$2 and movement_type='purchase_receipt'
      order by product_id`,
    [merchantId, r.id],
  );
  const acc = await client.query(
    `select id from public.accounting_events where source_type='purchase_receipt' and source_id=$1 and event_type='purchase_received'`,
    [r.id],
  );
  return {
    receiptId: r.id, receiptNumber: r.receipt_number, status: "posted",
    subtotalVnd: Number(r.subtotal_vnd), grandTotalVnd: Number(r.grand_total_vnd),
    movements: mv.rows.map((m) => ({ productId: m.product_id, movementId: m.movement_id, delta: round3(m.quantity_delta), after: round3(m.balance_after) })),
    accountingEventId: acc.rows[0]?.id ?? null, rowVersion: Number(r.row_version), replayed,
  };
}

/** POST /receiving/receipts/:id/cancel — abandon before post (no stock change). */
export async function cancelReceipt(merchantId, userId, receiptId, ifMatch) {
  return withTransaction(async (client) => {
    const r = await loadReceiptRow(client, merchantId, receiptId, true);
    if (r.status === "cancelled") return { receiptId, status: "cancelled" };
    if (r.status === "posted" || r.status === "reversed") fail("RECEIPT_INVALID_STATE");
    if (ifMatch != null && Number(r.row_version) !== Number(ifMatch)) fail("VERSION_CONFLICT");
    await client.query(`update public.purchase_receipts set status='cancelled', row_version=row_version+1 where id=$1`, [receiptId]);
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "receipt.cancelled",
      entityType: "purchase_receipt", entityId: receiptId, before: { status: r.status },
    });
    return { receiptId, status: "cancelled" };
  });
}

/**
 * POST /receiving/receipts/:id/reverse — reverse a posted receipt (spec 3.8 / 4.2
 * / REC-11). Appends opposite 'reversal' movements (original untouched) + a
 * 'reversed' accounting event. BLOCKS if any line would drive stock negative
 * because the goods were already sold (REC-08 / REC-12). Idempotent.
 */
export async function reverseReceipt(merchantId, userId, role, receiptId, input = {}, idemKey) {
  if (!idemKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const idemMarker = deterministicUuid(`rcpt-rev:${merchantId}:${idemKey}`);
  const { result, replayed } = await runIdempotent("receipt-reverse", idemKey, bodyHash({ receiptId }), async () => {
    return withTransaction(async (client) => {
      const r = await loadReceiptRow(client, merchantId, receiptId, true);
      if (r.status === "reversed") return buildReverseResult(client, merchantId, receiptId, true);
      if (r.status !== "posted") fail("RECEIPT_NOT_REVERSIBLE");

      // The original purchase movements, locked in product_id order (spec 5.1).
      const orig = await client.query(
        `select id, product_id, quantity_delta from public.inventory_movements
          where merchant_id=$1 and reference_type='purchase_receipt' and reference_id=$2 and movement_type='purchase_receipt'
          order by product_id`,
        [merchantId, receiptId],
      );

      const reversed = [];
      for (const m of orig.rows) {
        // Pre-check: would reversing drive stock negative (goods already sold)?
        const lvl = await client.query(
          `select coalesce(on_hand,0) as on_hand from public.inventory_levels
             where merchant_id=$1 and product_id=$2 for update`,
          [merchantId, m.product_id],
        );
        const onHand = lvl.rows.length ? round3(lvl.rows[0].on_hand) : 0;
        const revDelta = round3(-Number(m.quantity_delta));
        if (round3(onHand + revDelta) < 0) {
          fail("RECEIPT_REVERSE_NEGATIVE", undefined, { productId: m.product_id, onHand, needed: Math.abs(revDelta) });
        }
        const posted = await postMovementTx(client, {
          merchantId, productId: m.product_id, movementType: "reversal",
          delta: revDelta, referenceType: "movement", referenceId: m.id,
          sourceLineId: idemMarker, originalMovementId: m.id, reasonCode: "CORRECTION",
          note: input.note ? String(input.note).slice(0, 500) : null, userId,
        });
        reversed.push({ productId: m.product_id, movementId: posted.movementId, delta: revDelta, after: posted.balanceAfter });
      }

      // A 'reversed' accounting event coexists with 'purchase_received' (unique is
      // by event_type), so downstream nets them out.
      await client.query(
        `insert into public.accounting_events (merchant_id, source_type, source_id, event_type, amount_vnd, review_status)
         values ($1,'purchase_receipt',$2,'reversed',$3,'pending')
         on conflict (source_type, source_id, event_type) do nothing`,
        [merchantId, receiptId, Number(r.grand_total_vnd)],
      );
      await client.query(`update public.purchase_receipts set status='reversed', row_version=row_version+1 where id=$1`, [receiptId]);

      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "receipt.reversed",
        entityType: "purchase_receipt", entityId: receiptId,
        after: { reversedLines: reversed.length, reason: "CORRECTION", note: input.note ?? null },
      });
      await enqueueOutbox(client, {
        merchantId, eventType: "purchase_receipt.reversed", aggregateId: receiptId,
        payload: { receiptId, reversedLines: reversed.length },
      });

      return { receiptId, status: "reversed", reversedMovements: reversed, replayed: false };
    });
  });
  return { ...result, replayed };
}

async function buildReverseResult(client, merchantId, receiptId, replayed) {
  const mv = await client.query(
    `select rv.product_id, rv.id as movement_id, rv.quantity_delta, rv.balance_after
       from public.inventory_movements rv
      where rv.merchant_id=$1 and rv.movement_type='reversal' and rv.original_movement_id in (
        select id from public.inventory_movements
         where merchant_id=$1 and reference_type='purchase_receipt' and reference_id=$2)
      order by rv.product_id`,
    [merchantId, receiptId],
  );
  return {
    receiptId, status: "reversed",
    reversedMovements: mv.rows.map((m) => ({ productId: m.product_id, movementId: m.movement_id, delta: round3(m.quantity_delta), after: round3(m.balance_after) })),
    replayed,
  };
}
