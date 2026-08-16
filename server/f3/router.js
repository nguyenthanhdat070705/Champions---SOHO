// Functional 03 HTTP surface (spec 11). Pattern-matched routes under /v1/*,
// wired into the existing plain-Node server (server/application.js). Every
// mutating route verifies the caller's JWT and merchant membership/role before
// touching money/inventory (NFR-04); the client never supplies a trusted
// user/merchant id. Errors are mapped to the spec 11.1 contract.
import { DomainError, mapPgError } from "./errors.js";
import { verifyUser, requireMembership, getBearerToken, SELLING_ROLES, PRIVILEGED_ROLES } from "./auth.js";
import { hasDatabase } from "../db/pool.js";
import { devEndpointsEnabled } from "./env.js";
import { listProducts, quickCreateProduct } from "./catalog.js";
import {
  createProduct, updateProduct, changeProductStatus, getProductDetail,
  lookupByBarcode, listCategories, createCategory, renameCategory,
} from "./products.js";
import { aiProductPreview, aiConfirmSuggestion } from "./ai_products.js";
import {
  preview, createOrder, updateOrder, lockOrder, unlockOrder, cancelOrder,
  getOrder, listOrders, getActiveDraft, getOutstandingBill,
} from "./sales.js";
import {
  finalizeCash, createQrPayment, getPaymentStatus, cancelPayment, confirmQrPayment,
} from "./payments.js";
import { returnsPreview, createReturn, confirmRefund, listReturns } from "./returns.js";
import { renderReceiptHtml } from "./receipts.js";
import { getInventoryOverview, getProductLedger, getReconciliation } from "../f5/inventory.js";
import { previewAdjustment, postAdjustment, reverseMovement } from "../f5/adjustments.js";
import {
  createCountSession, getCountSession, saveCountItems, reviewCount, postCount,
  cancelCountSession, listCountSessions,
} from "../f5/counts.js";
import { assistantChat } from "../assistant/index.js";
import {
  createReceipt, getReceipt, listReceipts, updateReceipt, putItems,
  previewReceipt, postReceipt, cancelReceipt, reverseReceipt,
} from "../f6/receipts.js";
import { listSuppliers, createSupplier } from "../f6/suppliers.js";
import { createDocument, extractDocument, getDocumentUrl } from "../f6/documents.js";
import { listExpenseCategories } from "../f7/categories.js";
import {
  createDraft, updateDraft, postExpense, reverseExpense, getExpense, listExpenses,
  listDuplicateFindings, decideDuplicate,
} from "../f7/expenses.js";
import { aiExpensePreview } from "../f7/ai.js";
import {
  listDocuments, getDocumentDetail, getContent, uploadDocument,
  addLink, removeLink, listLinkCandidates, setArchiveState,
} from "../f8/documents.js";
import {
  listInvoices, listEligibleOrders, getInvoice, createDraft as createInvoiceDraft, updateBuyer,
  validateInvoice, submitInvoice, getStatus as getInvoiceStatus, processProviderEvent,
  simulateProviderDecision, retryDraft, createRelation, getArtifact,
} from "../f9/invoices.js";
import {
  getSummary, listEntries, getEntry, reverseEntry,
  listReview, getReview, patchReview, previewReview, postReview, excludeReview,
  createManualDraft,
} from "../f11/cashbook.js";
import { syncMerchant } from "../f11/ingest.js";
import { createRun, listRuns, getRun } from "../f12/engine.js";
import {
  getSummary as getReconSummary, listIssues, getIssue, markReview, requestAction, ignoreIssue, ruleCatalog,
} from "../f12/issues.js";
import {
  findOrBuildSnapshot, getSnapshot, listSnapshots, compareSnapshots, drilldown,
} from "../f13/snapshots.js";
import { createExport, getExportFile } from "../f13/export.js";
import {
  prepareClosing, getDraft, saveCount, previewClosing, confirmClosing,
  listClosings, getClosing, getRevisions, scanLateSources, resolveAttention,
} from "../f14/service.js";
// F15 aliases the snapshot/export names that clash with F13's above.
import {
  getOverview, previewLock, lockPeriod,
  listSnapshots as listAcctSnapshots, getSnapshot as getAcctSnapshot,
} from "../f15/periods.js";
import { bookLedger, recordDetail } from "../f15/books.js";
import { syncRange } from "../f15/ingest.js";
import { getCatalog } from "../f15/catalog.js";
import { buildPackage, getPackage } from "../f15/packages.js";
import { createExport as createAcctExport, listExports, getExportContent } from "../f15/exports.js";
import { resolvePeriod } from "../f15/period-util.js";
import { query } from "../db/pool.js";

const MAX_BODY = 1024 * 1024;
// The document upload route carries a base64 image (≤10 MB → ~14 MB encoded), so
// it needs a larger cap than the JSON control-plane routes (spec 12.4 pilot limit).
const MAX_UPLOAD_BODY = 20 * 1024 * 1024;

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) {
      // Already parsed upstream.
      if (typeof req.body === "string") {
        try { resolve(req.body ? JSON.parse(req.body) : {}); } catch { reject(new DomainError("VALIDATION", "JSON không hợp lệ.")); }
      } else resolve(req.body || {});
      return;
    }
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(new DomainError("VALIDATION", "Body quá lớn.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new DomainError("VALIDATION", "JSON không hợp lệ.")); }
    });
    req.on("error", reject);
  });
}

/** Read the request body as the raw UTF-8 string (webhook signature needs bytes). */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) {
      resolve(typeof req.body === "string" ? req.body : JSON.stringify(req.body));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new DomainError("VALIDATION", "Body quá lớn.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks).toString("utf8") : ""));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function sendErr(res, err) {
  const mapped = err instanceof DomainError ? err : mapPgError(err);
  if (mapped instanceof DomainError) {
    const body = { code: mapped.code, message: mapped.message };
    if (mapped.details) body.details = mapped.details;
    sendJson(res, mapped.status, body);
    return;
  }
  console.error("F3 unhandled error", err);
  sendJson(res, 500, { code: "INTERNAL", message: "Có lỗi xảy ra. Vui lòng thử lại." });
}

function idemKey(req) {
  const k = req.headers["idempotency-key"] || req.headers["Idempotency-Key"];
  return k ? String(k) : null;
}

/** Resolve an entity's merchant so cross-tenant access is blocked (RLS-01). */
async function merchantOfOrder(orderId) {
  const { rows } = await query(`select merchant_id from public.orders where id=$1`, [orderId]);
  return rows[0]?.merchant_id ?? null;
}
async function merchantOfPayment(paymentId) {
  const { rows } = await query(`select merchant_id from public.payments where id=$1`, [paymentId]);
  return rows[0]?.merchant_id ?? null;
}
async function merchantOfRefund(refundId) {
  const { rows } = await query(`select merchant_id from public.payment_refunds where id=$1`, [refundId]);
  return rows[0]?.merchant_id ?? null;
}

// Route table: [method, regex, handler]. Handler gets (ctx) with params + helpers.
const ROUTES = [
  // ── Catalog: list / search (spec 3.1 / 10 GET /products) ─────────────────────
  ["GET", /^\/v1\/merchants\/([^/]+)\/products$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    const result = await listProducts(merchantId, {
      search: sp.get("search") || undefined,
      categoryId: sp.get("category") || undefined,
      barcode: sp.get("barcode") || undefined,
      type: sp.get("type") || undefined,
      status: sp.get("status") || undefined,
      includeArchived: sp.get("includeArchived") === "1",
      limit: sp.get("limit") || undefined,
      offset: sp.get("offset") || undefined,
    });
    // Back-compat: the POS reads `.products`; the catalog also reads hasMore/nextOffset.
    sendJson(c.res, 200, result);
  }],
  // ── Catalog: full create (spec 3.7 / 10 POST /products, Idempotency-Key) ──────
  ["POST", /^\/v1\/merchants\/([^/]+)\/products$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    const { role } = await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await createProduct(merchantId, userId, role, body, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  // ── POS quick-create (spec 3.4) — cashiers allowed per policy ─────────────────
  ["POST", /^\/v1\/merchants\/([^/]+)\/products\/quick$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await quickCreateProduct(merchantId, userId, body);
    sendJson(c.res, 201, result);
  }],
  // ── Barcode lookup (spec 3.3 GET /products/barcode/:code) ─────────────────────
  ["GET", /^\/v1\/merchants\/([^/]+)\/products\/barcode\/([^/]+)$/, async (c) => {
    const [merchantId, code] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const result = await lookupByBarcode(merchantId, code);
    sendJson(c.res, 200, result);
  }],
  // ── AI shortcuts (spec 11) ────────────────────────────────────────────────────
  ["POST", /^\/v1\/merchants\/([^/]+)\/products\/ai\/preview$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await aiProductPreview(merchantId, userId, body);
    sendJson(c.res, 200, result);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/products\/ai\/([^/]+)\/confirm$/, async (c) => {
    const [merchantId, suggestionId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await aiConfirmSuggestion(merchantId, userId, suggestionId, body);
    sendJson(c.res, 200, result);
  }],
  // ── Status change (spec 3.8 / 10 POST /products/:id/status) ───────────────────
  ["POST", /^\/v1\/merchants\/([^/]+)\/products\/([^/]+)\/status$/, async (c) => {
    const [merchantId, productId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await changeProductStatus(merchantId, userId, productId, body.action, { reason: body.reason, ifMatch: body.expectedVersion });
    sendJson(c.res, 200, result);
  }],
  // ── Detail / edit (spec 3.8 GET|PATCH /products/:id) ──────────────────────────
  ["GET", /^\/v1\/merchants\/([^/]+)\/products\/([^/]+)$/, async (c) => {
    const [merchantId, productId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const result = await getProductDetail(merchantId, productId);
    sendJson(c.res, 200, result);
  }],
  ["PATCH", /^\/v1\/merchants\/([^/]+)\/products\/([^/]+)$/, async (c) => {
    const [merchantId, productId] = c.params;
    const { userId } = await verifyUser(c.req);
    const { role } = await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const ifMatchHeader = c.req.headers["if-match"];
    const ifMatch = body.expectedVersion != null ? body.expectedVersion
      : (ifMatchHeader != null ? Number(String(ifMatchHeader).replace(/"/g, "")) : null);
    const result = await updateProduct(merchantId, userId, role, productId, body, ifMatch);
    sendJson(c.res, 200, result);
  }],
  // ── Categories (spec 8.2 / 10) ────────────────────────────────────────────────
  ["GET", /^\/v1\/merchants\/([^/]+)\/categories$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, { categories: await listCategories(merchantId) });
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/categories$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await createCategory(merchantId, userId, body.name);
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["PATCH", /^\/v1\/merchants\/([^/]+)\/categories\/([^/]+)$/, async (c) => {
    const [merchantId, categoryId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await renameCategory(merchantId, userId, categoryId, body.name);
    sendJson(c.res, 200, result);
  }],

  // ── Functional 05: inventory ledger + adjustments ─────────────────────────
  // NB: more specific paths (reconciliation, adjustments, movements, counts) are
  // listed BEFORE the /inventory/:productId catch so they win the match.
  ["GET", /^\/v1\/merchants\/([^/]+)\/inventory$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    const result = await getInventoryOverview(merchantId, {
      search: sp.get("search") || undefined, filter: sp.get("filter") || undefined,
      limit: sp.get("limit") || undefined, offset: sp.get("offset") || undefined,
    });
    sendJson(c.res, 200, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/inventory\/reconciliation$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, ["owner"]);
    sendJson(c.res, 200, await getReconciliation(merchantId));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/inventory\/adjustments\/preview$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await previewAdjustment(merchantId, body));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/inventory\/adjustments$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    const { role } = await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await postAdjustment(merchantId, userId, role, body, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/inventory\/movements\/([^/]+)\/reverse$/, async (c) => {
    const [merchantId, movementId] = c.params;
    const { userId } = await verifyUser(c.req);
    const { role } = await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await reverseMovement(merchantId, userId, role, movementId, body, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/inventory\/([^/]+)$/, async (c) => {
    const [merchantId, productId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await getProductLedger(merchantId, productId, {
      limit: sp.get("limit") || undefined, before: sp.get("before") || undefined,
    }));
  }],

  // ── Functional 05: stock counts (kiểm kê) ─────────────────────────────────
  ["POST", /^\/v1\/merchants\/([^/]+)\/inventory-counts$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await createCountSession(merchantId, userId, body, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/inventory-counts$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await listCountSessions(merchantId, { limit: c.url.searchParams.get("limit") || undefined }));
  }],
  ["PATCH", /^\/v1\/merchants\/([^/]+)\/inventory-counts\/([^/]+)\/items$/, async (c) => {
    const [merchantId, sessionId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await saveCountItems(merchantId, userId, sessionId, body));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/inventory-counts\/([^/]+)\/review$/, async (c) => {
    const [merchantId, sessionId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await reviewCount(merchantId, userId, sessionId));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/inventory-counts\/([^/]+)\/post$/, async (c) => {
    const [merchantId, sessionId] = c.params;
    const { userId } = await verifyUser(c.req);
    const { role } = await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const result = await postCount(merchantId, userId, role, sessionId, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/inventory-counts\/([^/]+)\/cancel$/, async (c) => {
    const [merchantId, sessionId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await cancelCountSession(merchantId, userId, sessionId));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/inventory-counts\/([^/]+)$/, async (c) => {
    const [merchantId, sessionId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getCountSession(merchantId, sessionId));
  }],

  // ── Functional 06: goods receiving (nhập hàng) ────────────────────────────
  // Suppliers (minimal). More specific paths first, then receipts/:id catch.
  ["GET", /^\/v1\/merchants\/([^/]+)\/receiving\/suppliers$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await listSuppliers(merchantId, { search: c.url.searchParams.get("search") || undefined }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/receiving\/suppliers$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 201, await createSupplier(merchantId, userId, await readBody(c.req)));
  }],
  // Documents: upload + dedupe (+ inline extract), retry-extract, signed URL.
  ["POST", /^\/v1\/merchants\/([^/]+)\/receiving\/documents$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const token = getBearerToken(c.req);
    sendJson(c.res, 201, await createDocument(merchantId, userId, token, await readBody(c.req)));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/receiving\/documents\/([^/]+)\/extract$/, async (c) => {
    const [merchantId, documentId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const token = getBearerToken(c.req);
    sendJson(c.res, 200, await extractDocument(merchantId, userId, token, documentId));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/receiving\/documents\/([^/]+)\/url$/, async (c) => {
    const [merchantId, documentId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const token = getBearerToken(c.req);
    sendJson(c.res, 200, await getDocumentUrl(merchantId, token, documentId));
  }],
  // Receipts CRUD + lifecycle.
  ["GET", /^\/v1\/merchants\/([^/]+)\/receiving\/receipts$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await listReceipts(merchantId, {
      status: sp.get("status") || undefined, search: sp.get("search") || undefined, limit: sp.get("limit") || undefined,
    }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/receiving\/receipts$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const result = await createReceipt(merchantId, userId, await readBody(c.req), idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/receiving\/receipts\/([^/]+)\/preview$/, async (c) => {
    const [merchantId, receiptId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await previewReceipt(merchantId, userId, receiptId));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/receiving\/receipts\/([^/]+)\/post$/, async (c) => {
    const [merchantId, receiptId] = c.params;
    const { userId } = await verifyUser(c.req);
    const { role } = await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const result = await postReceipt(merchantId, userId, role, receiptId, await readBody(c.req), idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/receiving\/receipts\/([^/]+)\/cancel$/, async (c) => {
    const [merchantId, receiptId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await cancelReceipt(merchantId, userId, receiptId, body.expectedVersion));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/receiving\/receipts\/([^/]+)\/reverse$/, async (c) => {
    const [merchantId, receiptId] = c.params;
    const { userId } = await verifyUser(c.req);
    const { role } = await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const result = await reverseReceipt(merchantId, userId, role, receiptId, await readBody(c.req), idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["PUT", /^\/v1\/merchants\/([^/]+)\/receiving\/receipts\/([^/]+)\/items$/, async (c) => {
    const [merchantId, receiptId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await putItems(merchantId, userId, receiptId, await readBody(c.req)));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/receiving\/receipts\/([^/]+)$/, async (c) => {
    const [merchantId, receiptId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getReceipt(merchantId, receiptId));
  }],
  ["PATCH", /^\/v1\/merchants\/([^/]+)\/receiving\/receipts\/([^/]+)$/, async (c) => {
    const [merchantId, receiptId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await updateReceipt(merchantId, userId, receiptId, body, body.expectedVersion));
  }],

  // ── Functional 08: Hộp chứng từ (documents) ───────────────────────────────
  // NB: specific sub-paths (link-candidates, links, content, archive) MUST be
  // listed before /documents/:id so they win the match.
  ["GET", /^\/v1\/merchants\/([^/]+)\/documents$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await listDocuments(merchantId, getBearerToken(c.req), {
      search: sp.get("search") || undefined, type: sp.get("type") || undefined,
      linked: sp.get("linked") || undefined, month: sp.get("month") || undefined,
      includeArchived: sp.get("includeArchived") === "1",
      limit: sp.get("limit") || undefined, offset: sp.get("offset") || undefined,
    }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/documents$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req, MAX_UPLOAD_BODY);
    const result = await uploadDocument(merchantId, userId, getBearerToken(c.req), body, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/documents\/link-candidates$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await listLinkCandidates(merchantId, sp.get("targetType"), sp.get("search") || undefined));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/documents\/([^/]+)\/links$/, async (c) => {
    const [merchantId, documentId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 201, await addLink(merchantId, userId, documentId, body, idemKey(c.req)));
  }],
  ["DELETE", /^\/v1\/merchants\/([^/]+)\/documents\/([^/]+)\/links\/([^/]+)$/, async (c) => {
    const [merchantId, documentId, linkId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await removeLink(merchantId, userId, documentId, linkId));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/documents\/([^/]+)\/content$/, async (c) => {
    const [merchantId, documentId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getContent(merchantId, userId, getBearerToken(c.req), documentId, c.url.searchParams.get("action") || "preview"));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/documents\/([^/]+)\/archive$/, async (c) => {
    const [merchantId, documentId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await setArchiveState(merchantId, userId, documentId, body.action || "archive", body.expectedVersion));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/documents\/([^/]+)$/, async (c) => {
    const [merchantId, documentId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getDocumentDetail(merchantId, documentId));
  }],

  // ── Functional 09: hóa đơn điện tử (e-invoice) ────────────────────────────
  // NB: specific paths (invoice-eligible, artifacts, status, validate, submit,
  // buyer, retry-draft, relations) precede the generic /e-invoices/:id GET.
  ["GET", /^\/v1\/merchants\/([^/]+)\/orders\/invoice-eligible$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await listEligibleOrders(merchantId, { search: sp.get("search") || undefined, limit: sp.get("limit") || undefined }));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/e-invoices$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await listInvoices(merchantId, { status: sp.get("status") || undefined, search: sp.get("search") || undefined, limit: sp.get("limit") || undefined }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/e-invoices$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await createInvoiceDraft(merchantId, userId, body, idemKey(c.req));
    sendJson(c.res, result.existing || result.replayed ? 200 : 201, result);
  }],
  ["PATCH", /^\/v1\/merchants\/([^/]+)\/e-invoices\/([^/]+)\/buyer$/, async (c) => {
    const [merchantId, invoiceId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const ifMatchHeader = c.req.headers["if-match"];
    const ifMatch = body.expectedVersion != null ? Number(body.expectedVersion)
      : (ifMatchHeader != null ? Number(String(ifMatchHeader).replace(/"/g, "")) : null);
    sendJson(c.res, 200, await updateBuyer(merchantId, userId, invoiceId, body.buyer || body, ifMatch));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/e-invoices\/([^/]+)\/validate$/, async (c) => {
    const [merchantId, invoiceId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await validateInvoice(merchantId, userId, invoiceId, body.expectedVersion));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/e-invoices\/([^/]+)\/submit$/, async (c) => {
    const [merchantId, invoiceId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await submitInvoice(merchantId, userId, invoiceId, body, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 202, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/e-invoices\/([^/]+)\/status$/, async (c) => {
    const [merchantId, invoiceId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getInvoiceStatus(merchantId, invoiceId, { reconcile: c.url.searchParams.get("reconcile") === "1" }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/e-invoices\/([^/]+)\/retry-draft$/, async (c) => {
    const [merchantId, invoiceId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const result = await retryDraft(merchantId, userId, invoiceId, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/e-invoices\/([^/]+)\/relations$/, async (c) => {
    const [merchantId, invoiceId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await createRelation(merchantId, userId, invoiceId, body, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/e-invoices\/([^/]+)\/artifacts\/([^/]+)$/, async (c) => {
    const [merchantId, invoiceId, type] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const a = await getArtifact(merchantId, invoiceId, type);
    c.res.setHeader("Content-Type", a.contentType);
    c.res.setHeader("Cache-Control", "no-store");
    c.res.setHeader("Content-Disposition", `inline; filename="${a.filename}"`);
    c.res.statusCode = 200;
    c.res.end(a.body);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/e-invoices\/([^/]+)$/, async (c) => {
    const [merchantId, invoiceId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getInvoice(merchantId, invoiceId));
  }],
  // Provider webhook — NO user session; signature is the trust boundary (spec 9.4).
  ["POST", /^\/v1\/webhooks\/e-invoice\/([^/]+)$/, async (c) => {
    const [provider] = c.params;
    const raw = await readRawBody(c.req);
    const signature = c.req.headers["x-provider-signature"] || c.req.headers["x-signature"] || "";
    const result = await processProviderEvent({ providerCode: provider, rawBody: raw, signature: String(signature) });
    sendJson(c.res, 200, result);
  }],
  // Dev-only: drive an accept/reject decision through the same event path.
  ["POST", /^\/v1\/dev\/e-invoice\/simulate$/, async (c) => {
    if (!devEndpointsEnabled()) { sendErr(c.res, new DomainError("NOT_FOUND")); return; }
    const { userId } = await verifyUser(c.req);
    const body = await readBody(c.req);
    await requireMembership(userId, body.merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await simulateProviderDecision(body.merchantId, body));
  }],

  // ── Preview / draft ──────────────────────────────────────────────────────
  ["POST", /^\/v1\/merchants\/([^/]+)\/sales\/preview$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    const { role } = await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await preview(merchantId, { items: body.items, adjustments: body.adjustments, role });
    sendJson(c.res, 200, result);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/orders$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    const { role } = await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await createOrder(merchantId, userId, role, body);
    sendJson(c.res, 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/orders$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const result = await listOrders(merchantId, {
      businessDate: c.url.searchParams.get("businessDate") || undefined,
      status: c.url.searchParams.get("status") || undefined,
      limit: c.url.searchParams.get("limit") || undefined,
    });
    sendJson(c.res, 200, { orders: result });
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/active-draft$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const result = await getActiveDraft(merchantId, userId);
    sendJson(c.res, 200, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/outstanding-bill$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const excludeOrderId = c.url.searchParams.get("excludeOrderId") || undefined;
    const result = await getOutstandingBill(merchantId, userId, excludeOrderId);
    sendJson(c.res, 200, result);
  }],

  // ── Order by id (merchant resolved from the order) ───────────────────────
  ["PATCH", /^\/v1\/orders\/([^/]+)$/, async (c) => {
    const [orderId] = c.params;
    const { userId } = await verifyUser(c.req);
    const merchantId = await merchantOfOrder(orderId);
    const { role } = await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await updateOrder(merchantId, userId, role, orderId, body);
    sendJson(c.res, 200, result);
  }],
  ["GET", /^\/v1\/orders\/([^/]+)$/, async (c) => {
    const [orderId] = c.params;
    const { userId } = await verifyUser(c.req);
    const merchantId = await merchantOfOrder(orderId);
    await requireMembership(userId, merchantId);
    const result = await getOrder(merchantId, orderId);
    const returns = await listReturns(merchantId, orderId);
    sendJson(c.res, 200, { ...result, returns });
  }],
  ["POST", /^\/v1\/orders\/([^/]+)\/lock$/, async (c) => {
    const [orderId] = c.params;
    const { userId } = await verifyUser(c.req);
    const merchantId = await merchantOfOrder(orderId);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await lockOrder(merchantId, userId, orderId, body.expectedVersion);
    sendJson(c.res, 200, result);
  }],
  ["POST", /^\/v1\/orders\/([^/]+)\/unlock$/, async (c) => {
    const [orderId] = c.params;
    const { userId } = await verifyUser(c.req);
    const merchantId = await merchantOfOrder(orderId);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await unlockOrder(merchantId, orderId, body.expectedVersion);
    sendJson(c.res, 200, result);
  }],
  ["POST", /^\/v1\/orders\/([^/]+)\/cancel$/, async (c) => {
    const [orderId] = c.params;
    const { userId } = await verifyUser(c.req);
    const merchantId = await merchantOfOrder(orderId);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await cancelOrder(merchantId, userId, orderId, body.expectedVersion);
    sendJson(c.res, 200, result);
  }],
  ["GET", /^\/v1\/orders\/([^/]+)\/receipt$/, async (c) => {
    const [orderId] = c.params;
    const { userId } = await verifyUser(c.req);
    const merchantId = await merchantOfOrder(orderId);
    await requireMembership(userId, merchantId);
    const html = await renderReceiptHtml(merchantId, orderId);
    if (!html) { sendErr(c.res, new DomainError("ORDER_NOT_FOUND")); return; }
    c.res.setHeader("Content-Type", "text/html; charset=utf-8");
    c.res.setHeader("Cache-Control", "no-store");
    c.res.statusCode = 200;
    c.res.end(html);
  }],

  // ── Payments ─────────────────────────────────────────────────────────────
  ["POST", /^\/v1\/payments\/cash$/, async (c) => {
    const { userId } = await verifyUser(c.req);
    const body = await readBody(c.req);
    await requireMembership(userId, body.merchantId, SELLING_ROLES);
    const result = await finalizeCash(body.merchantId, userId,
      { orderId: body.orderId, expectedVersion: body.expectedVersion, cashReceived: body.cashReceived },
      idemKey(c.req));
    sendJson(c.res, 200, result);
  }],
  ["POST", /^\/v1\/payments\/qr$/, async (c) => {
    const { userId } = await verifyUser(c.req);
    const body = await readBody(c.req);
    await requireMembership(userId, body.merchantId, SELLING_ROLES);
    const result = await createQrPayment(body.merchantId, userId,
      { orderId: body.orderId, expectedVersion: body.expectedVersion }, idemKey(c.req));
    sendJson(c.res, 201, result);
  }],
  ["GET", /^\/v1\/payments\/([^/]+)$/, async (c) => {
    const [paymentId] = c.params;
    const { userId } = await verifyUser(c.req);
    const merchantId = await merchantOfPayment(paymentId);
    await requireMembership(userId, merchantId);
    const result = await getPaymentStatus(merchantId, paymentId, {
      reconcile: c.url.searchParams.get("reconcile") === "1",
    });
    sendJson(c.res, 200, result);
  }],
  ["POST", /^\/v1\/payments\/([^/]+)\/cancel$/, async (c) => {
    const [paymentId] = c.params;
    const { userId } = await verifyUser(c.req);
    const merchantId = await merchantOfPayment(paymentId);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await cancelPayment(merchantId, userId, paymentId, body.reason);
    sendJson(c.res, 200, result);
  }],

  // ── Returns / refunds ────────────────────────────────────────────────────
  ["POST", /^\/v1\/orders\/([^/]+)\/returns\/preview$/, async (c) => {
    const [orderId] = c.params;
    const { userId } = await verifyUser(c.req);
    const merchantId = await merchantOfOrder(orderId);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await returnsPreview(merchantId, orderId, body.items || []);
    sendJson(c.res, 200, result);
  }],
  ["POST", /^\/v1\/orders\/([^/]+)\/returns$/, async (c) => {
    const [orderId] = c.params;
    const { userId } = await verifyUser(c.req);
    const merchantId = await merchantOfOrder(orderId);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await createReturn(merchantId, userId, orderId, body, idemKey(c.req));
    sendJson(c.res, 201, result);
  }],
  ["POST", /^\/v1\/refunds\/([^/]+)\/confirm$/, async (c) => {
    const [refundId] = c.params;
    const { userId } = await verifyUser(c.req);
    const merchantId = await merchantOfRefund(refundId);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await confirmRefund(merchantId, userId, refundId, body.reference);
    sendJson(c.res, 200, result);
  }],

  // ── AI Assistant (Functional 10) — read-only, tenant-scoped ──────────────
  ["POST", /^\/v1\/assistant\/chat$/, async (c) => {
    const { userId } = await verifyUser(c.req);
    const body = await readBody(c.req);
    // Any ACTIVE member of the merchant may use the read-only assistant; the
    // membership check is the tenant guard (the pooler bypasses RLS). A user who
    // is not a member of body.merchantId gets FORBIDDEN — no cross-tenant facts.
    await requireMembership(userId, body.merchantId);
    const result = await assistantChat(query, body.merchantId, body.messages || []);
    sendJson(c.res, 200, result);
  }],

  // ── Functional 07: expenses (ghi nhận chi phí) ───────────────────────────
  // Specific paths listed BEFORE the generic /expenses/:id so they win the match.
  ["GET", /^\/v1\/merchants\/([^/]+)\/expense-categories$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, { categories: await listExpenseCategories(merchantId) });
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/expenses\/ai\/preview$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await aiExpensePreview(merchantId, userId, body));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/expenses$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await listExpenses(merchantId, {
      month: sp.get("month") || undefined, status: sp.get("status") || undefined,
      categoryId: sp.get("category") || undefined, search: sp.get("search") || undefined,
      limit: sp.get("limit") || undefined,
    }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/expenses$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await createDraft(merchantId, userId, body, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/expenses\/([^/]+)\/duplicates$/, async (c) => {
    const [merchantId, expenseId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await listDuplicateFindings(merchantId, expenseId));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/expenses\/([^/]+)\/duplicate-decision$/, async (c) => {
    const [merchantId, expenseId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await decideDuplicate(merchantId, userId, expenseId, body.findingId, body.decision));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/expenses\/([^/]+)\/post$/, async (c) => {
    const [merchantId, expenseId] = c.params;
    const { userId } = await verifyUser(c.req);
    const { role } = await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await postExpense(merchantId, userId, role, expenseId, body, idemKey(c.req));
    sendJson(c.res, (result.replayed || result.alreadyPosted) ? 200 : 201, result);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/expenses\/([^/]+)\/reverse$/, async (c) => {
    const [merchantId, expenseId] = c.params;
    const { userId } = await verifyUser(c.req);
    const { role } = await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await reverseExpense(merchantId, userId, role, expenseId, body, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/expenses\/([^/]+)$/, async (c) => {
    const [merchantId, expenseId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getExpense(merchantId, expenseId));
  }],
  ["PATCH", /^\/v1\/merchants\/([^/]+)\/expenses\/([^/]+)$/, async (c) => {
    const [merchantId, expenseId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const ifMatchHeader = c.req.headers["if-match"];
    const ifMatch = body.expectedVersion != null ? Number(body.expectedVersion)
      : (ifMatchHeader != null ? Number(String(ifMatchHeader).replace(/"/g, "")) : null);
    sendJson(c.res, 200, await updateDraft(merchantId, userId, expenseId, body, ifMatch));
  }],


  // ── Functional 11: Sổ thu–chi tự động (cashbook) ─────────────────────────
  // Reads = any ACTIVE member; writes (review/post/exclude/reverse/manual/sync)
  // = owner/manager (spec §12.1). Specific paths BEFORE the /:id catches.
  ["GET", /^\/v1\/merchants\/([^/]+)\/cashbook\/summary$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await getSummary(merchantId, {
      period: sp.get("period") || undefined, from: sp.get("from") || undefined, to: sp.get("to") || undefined,
    }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/cashbook\/sync$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await syncMerchant(merchantId, { limit: body.limit }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/cashbook\/manual-drafts$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await createManualDraft(merchantId, userId, body, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/cashbook\/entries$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await listEntries(merchantId, {
      direction: sp.get("direction") || undefined, entryType: sp.get("entryType") || undefined,
      method: sp.get("method") || undefined, status: sp.get("status") || undefined,
      from: sp.get("from") || undefined, to: sp.get("to") || undefined,
      cursor: sp.get("cursor") || undefined, limit: sp.get("limit") || undefined,
    }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/cashbook\/entries\/([^/]+)\/reverse$/, async (c) => {
    const [merchantId, entryId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const result = await reverseEntry(merchantId, userId, entryId, await readBody(c.req), idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/cashbook\/entries\/([^/]+)$/, async (c) => {
    const [merchantId, entryId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getEntry(merchantId, entryId));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/cashbook\/review$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await listReview(merchantId, {
      status: sp.get("status") || undefined, reasonCode: sp.get("reasonCode") || undefined,
    }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/cashbook\/review\/([^/]+)\/preview$/, async (c) => {
    const [merchantId, reviewId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await previewReview(merchantId, reviewId));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/cashbook\/review\/([^/]+)\/post$/, async (c) => {
    const [merchantId, reviewId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const result = await postReview(merchantId, userId, reviewId, await readBody(c.req), idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/cashbook\/review\/([^/]+)\/exclude$/, async (c) => {
    const [merchantId, reviewId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await excludeReview(merchantId, userId, reviewId, await readBody(c.req)));
  }],
  ["PATCH", /^\/v1\/merchants\/([^/]+)\/cashbook\/review\/([^/]+)$/, async (c) => {
    const [merchantId, reviewId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const ifMatch = body.expectedRowVersion != null ? body.expectedRowVersion
      : (c.req.headers["if-match"] != null ? Number(String(c.req.headers["if-match"]).replace(/"/g, "")) : null);
    sendJson(c.res, 200, await patchReview(merchantId, userId, reviewId, body, ifMatch));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/cashbook\/review\/([^/]+)$/, async (c) => {
    const [merchantId, reviewId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getReview(merchantId, reviewId));
  }],

  // ── Functional 12: reconciliation (đối soát) ─────────────────────────────
  // Reads = any ACTIVE member; run + resolve = owner/manager (spec 12.1). More
  // specific paths listed BEFORE the generic /issues/:id so they win the match.
  ["POST", /^\/v1\/merchants\/([^/]+)\/reconciliation\/runs$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await createRun(merchantId, userId, { scope: body.scope, dryRun: body.dryRun === true }, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/reconciliation\/runs$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await listRuns(merchantId, { limit: c.url.searchParams.get("limit") || undefined }));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/reconciliation\/runs\/([^/]+)$/, async (c) => {
    const [merchantId, runId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getRun(merchantId, runId));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/reconciliation\/summary$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getReconSummary(merchantId));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/reconciliation\/rules$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, ruleCatalog());
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/reconciliation\/issues$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await listIssues(merchantId, {
      status: sp.get("status") || undefined, family: sp.get("family") || undefined,
      impact: sp.get("impact") || undefined, limit: sp.get("limit") || undefined,
    }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/reconciliation\/issues\/([^/]+)\/review$/, async (c) => {
    const [merchantId, issueId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await markReview(merchantId, userId, issueId, body.expectedVersion));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/reconciliation\/issues\/([^/]+)\/action$/, async (c) => {
    const [merchantId, issueId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await requestAction(merchantId, userId, issueId, body));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/reconciliation\/issues\/([^/]+)\/ignore$/, async (c) => {
    const [merchantId, issueId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await ignoreIssue(merchantId, userId, issueId, body));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/reconciliation\/issues\/([^/]+)$/, async (c) => {
    const [merchantId, issueId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getIssue(merchantId, issueId));
  }],

  // ── Functional 13: Báo cáo kinh doanh (snapshot reports) ─────────────────
  // reports.read = owner/manager only (spec 12.1 — thu ngân không xem báo cáo).
  // Specific sub-paths first; the generic /snapshots/:sid GET is anchored so it
  // never shadows /drilldown or /exports (all regexes end with $).
  ["GET", /^\/v1\/merchants\/([^/]+)\/reports\/snapshots$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await listSnapshots(merchantId, { limit: c.url.searchParams.get("limit") || undefined }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/reports\/snapshots$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await findOrBuildSnapshot(merchantId, userId, body, idemKey(c.req));
    sendJson(c.res, 200, result);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/reports\/compare$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await compareSnapshots(merchantId, body.baseId, body.compareId));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/reports\/snapshots\/([^/]+)\/drilldown$/, async (c) => {
    const [merchantId, snapshotId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await drilldown(merchantId, snapshotId, {
      metric: sp.get("metric") || undefined, date: sp.get("date") || undefined,
      channel: sp.get("channel") || undefined, categoryId: sp.get("categoryId"),
      productId: sp.get("productId") || undefined, limit: sp.get("limit") || undefined,
    }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/reports\/snapshots\/([^/]+)\/exports$/, async (c) => {
    const [merchantId, snapshotId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 201, await createExport(merchantId, userId, snapshotId, body.exportType || "csv"));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/reports\/snapshots\/([^/]+)\/exports\/([^/]+)\/download$/, async (c) => {
    const [merchantId, snapshotId, exportId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const file = await getExportFile(merchantId, snapshotId, exportId);
    c.res.setHeader("Content-Type", file.contentType);
    c.res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    c.res.setHeader("Cache-Control", "no-store");
    c.res.statusCode = 200;
    c.res.end(file.csv);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/reports\/snapshots\/([^/]+)$/, async (c) => {
    const [merchantId, snapshotId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await getSnapshot(merchantId, snapshotId));
  }],

  // ── Functional 14: Chốt tiền cuối ngày (end-of-day cash closing) ─────────
  // Reads = any ACTIVE member; writes (prepare/count/preview/confirm/scan/
  // resolve) = owner/manager (spec §12.1). Specific paths BEFORE /:id catches.
  ["GET", /^\/v1\/merchants\/([^/]+)\/closings$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    sendJson(c.res, 200, await listClosings(merchantId, { from: sp.get("from") || undefined, to: sp.get("to") || undefined }));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/closings\/prepare$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 201, await prepareClosing(merchantId, userId, await readBody(c.req)));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/closings\/([^/]+)\/revisions$/, async (c) => {
    const [merchantId, closingId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getRevisions(merchantId, closingId));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/closings\/([^/]+)\/attention\/scan$/, async (c) => {
    const [merchantId, closingId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await scanLateSources(merchantId, userId, closingId));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/closings\/([^/]+)$/, async (c) => {
    const [merchantId, closingId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getClosing(merchantId, closingId));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/closing-drafts\/([^/]+)$/, async (c) => {
    const [merchantId, draftId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getDraft(merchantId, draftId));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/closing-drafts\/([^/]+)\/counts$/, async (c) => {
    const [merchantId, draftId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 201, await saveCount(merchantId, userId, draftId, await readBody(c.req)));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/closing-drafts\/([^/]+)\/preview$/, async (c) => {
    const [merchantId, draftId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await previewClosing(merchantId, draftId, await readBody(c.req)));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/closing-drafts\/([^/]+)\/confirm$/, async (c) => {
    const [merchantId, draftId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const result = await confirmClosing(merchantId, userId, draftId, await readBody(c.req), idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/closing-attention\/([^/]+)\/resolve$/, async (c) => {
    const [merchantId, attentionId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    sendJson(c.res, 200, await resolveAttention(merchantId, userId, attentionId, await readBody(c.req)));
  }],

  // ── Functional 15: Sổ kế toán & dữ liệu thuế ─────────────────────────────
  // Reads = any ACTIVE member; sync/preview/lock/build/export = owner/manager
  // (spec §12.1). Specific paths listed BEFORE generic /:id catches. NB: F15
  // snapshot/export helpers are aliased (getAcctSnapshot/…) to avoid the F13 clash.
  ["GET", /^\/v1\/merchants\/([^/]+)\/accounting\/overview$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getOverview(merchantId, c.url.searchParams.get("period") || undefined));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/accounting\/catalog$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getCatalog());
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/accounting\/sync$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await syncRange(merchantId, { from: body.from, to: body.to, limit: body.limit }));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/accounting\/snapshots$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await listAcctSnapshots(merchantId, c.url.searchParams.get("period") || undefined));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/accounting\/snapshots\/([^/]+)\/exports$/, async (c) => {
    const [merchantId, snapshotId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await listExports(merchantId, snapshotId));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/accounting\/snapshots\/([^/]+)$/, async (c) => {
    const [merchantId, snapshotId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getAcctSnapshot(merchantId, snapshotId));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/accounting\/periods\/preview$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    sendJson(c.res, 200, await previewLock(merchantId, body.period));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/accounting\/periods\/lock$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await lockPeriod(merchantId, userId, body.period, body, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/accounting\/books\/([^/]+)$/, async (c) => {
    const [merchantId, bookCode] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const sp = c.url.searchParams;
    let period, watermark;
    const snapshotId = sp.get("snapshotId");
    if (snapshotId) {
      const snap = await getAcctSnapshot(merchantId, snapshotId);
      period = resolvePeriod(snap.snapshot.periodStart.slice(0, 7));
      period = { ...period, start: snap.snapshot.periodStart, end: snap.snapshot.periodEnd, label: period.label };
      watermark = snap.snapshot.asOf;
    } else {
      period = resolvePeriod(sp.get("period") || undefined);
    }
    sendJson(c.res, 200, await bookLedger(merchantId, bookCode, period, { watermark, limit: sp.get("limit") || undefined }));
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/accounting\/records\/([^/]+)$/, async (c) => {
    const [merchantId, recordId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await recordDetail(merchantId, recordId));
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/accounting\/exports$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await createAcctExport(merchantId, userId, { snapshotId: body.snapshotId, scope: body.scope, format: body.format });
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/accounting\/exports\/([^/]+)\/download$/, async (c) => {
    const [merchantId, exportId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const a = await getExportContent(merchantId, userId, exportId);
    c.res.setHeader("Content-Type", a.contentType);
    c.res.setHeader("Cache-Control", "no-store");
    c.res.setHeader("Content-Disposition", `attachment; filename="${a.filename}"`);
    c.res.statusCode = 200;
    c.res.end(a.body);
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/tax-data\/packages$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, PRIVILEGED_ROLES);
    const body = await readBody(c.req);
    const result = await buildPackage(merchantId, userId, body.snapshotId, idemKey(c.req));
    sendJson(c.res, result.replayed ? 200 : 201, result);
  }],
  ["GET", /^\/v1\/merchants\/([^/]+)\/tax-data\/packages\/([^/]+)$/, async (c) => {
    const [merchantId, packageId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    sendJson(c.res, 200, await getPackage(merchantId, packageId));
  }],

  // ── Dev-only PayOS webhook simulator (spec brief G12) ────────────────────
  ["POST", /^\/v1\/dev\/payos\/simulate$/, async (c) => {
    if (!devEndpointsEnabled()) { sendErr(c.res, new DomainError("NOT_FOUND")); return; }
    const body = await readBody(c.req);
    let event = body;
    if (body.paymentId && !body.paymentLinkId) {
      const { rows } = await query(
        `select provider_payment_id, amount from public.payments where id=$1`, [body.paymentId]);
      if (rows.length === 0) { sendErr(c.res, new DomainError("PAYMENT_NOT_FOUND")); return; }
      event = {
        paymentLinkId: rows[0].provider_payment_id,
        amount: body.amount != null ? body.amount : Number(rows[0].amount),
        reference: body.reference || `DEVSIM-${body.paymentId}`,
        signatureValid: body.signatureValid !== false,
        eventType: "payment.paid",
        provider: "payos",
      };
    }
    const result = await confirmQrPayment(event);
    sendJson(c.res, 200, result);
  }],
];

/**
 * Try to handle a /v1/* request. Returns true if handled (response sent),
 * false if this isn't an F3 route (caller continues to static serving).
 */
export async function handleF3Request(req, res, url) {
  const pathname = url.pathname;
  if (!pathname.startsWith("/v1/")) return false;
  if (!hasDatabase()) {
    sendJson(res, 503, { code: "OFFLINE", message: "Máy chủ chưa cấu hình cơ sở dữ liệu." });
    return true;
  }

  for (const [method, regex, handler] of ROUTES) {
    const m = pathname.match(regex);
    if (!m) continue;
    if (req.method !== method) continue;
    const params = m.slice(1).map((p) => decodeURIComponent(p));
    try {
      await handler({ req, res, url, params });
    } catch (err) {
      sendErr(res, err);
    }
    return true;
  }
  // No method/path match under /v1 → 404 JSON (still "handled").
  sendJson(res, 404, { code: "NOT_FOUND", message: "Không tìm thấy endpoint." });
  return true;
}
