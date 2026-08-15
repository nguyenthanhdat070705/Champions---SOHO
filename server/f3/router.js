// Functional 03 HTTP surface (spec 11). Pattern-matched routes under /v1/*,
// wired into the existing plain-Node server (server/application.js). Every
// mutating route verifies the caller's JWT and merchant membership/role before
// touching money/inventory (NFR-04); the client never supplies a trusted
// user/merchant id. Errors are mapped to the spec 11.1 contract.
import { DomainError, mapPgError } from "./errors.js";
import { verifyUser, requireMembership, SELLING_ROLES } from "./auth.js";
import { hasDatabase } from "../db/pool.js";
import { devEndpointsEnabled } from "./env.js";
import { listProducts, quickCreateProduct } from "./catalog.js";
import {
  preview, createOrder, updateOrder, lockOrder, unlockOrder, cancelOrder,
  getOrder, listOrders, getActiveDraft,
} from "./sales.js";
import {
  finalizeCash, createQrPayment, getPaymentStatus, cancelPayment, confirmQrPayment,
} from "./payments.js";
import { returnsPreview, createReturn, confirmRefund, listReturns } from "./returns.js";
import { renderReceiptHtml } from "./receipts.js";
import { assistantChat } from "../assistant/index.js";
import { query } from "../db/pool.js";

const MAX_BODY = 1024 * 1024;

function readBody(req) {
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
      if (size > MAX_BODY) { reject(new DomainError("VALIDATION", "Body quá lớn.")); req.destroy(); return; }
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
  // ── Catalog ────────────────────────────────────────────────────────────────
  ["GET", /^\/v1\/merchants\/([^/]+)\/products$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId);
    const items = await listProducts(merchantId, {
      search: c.url.searchParams.get("search") || undefined,
      categoryId: c.url.searchParams.get("category") || undefined,
      barcode: c.url.searchParams.get("barcode") || undefined,
    });
    sendJson(c.res, 200, { products: items });
  }],
  ["POST", /^\/v1\/merchants\/([^/]+)\/products\/quick$/, async (c) => {
    const [merchantId] = c.params;
    const { userId } = await verifyUser(c.req);
    await requireMembership(userId, merchantId, SELLING_ROLES);
    const body = await readBody(c.req);
    const result = await quickCreateProduct(merchantId, userId, body);
    sendJson(c.res, 201, result);
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
