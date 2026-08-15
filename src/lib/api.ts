// Client → Functional 03 server API. Every call attaches the current Supabase
// access token as a Bearer (the server derives the trusted user id from it, never
// the client). Errors follow the spec 11.1 contract and are surfaced as typed
// ApiError so screens can switch on `.code` (VERSION_CONFLICT, PRICE_CHANGED,
// INSUFFICIENT_STOCK, PAYMENT_ALREADY_SUCCEEDED, …). Same-origin in production;
// the Vite dev proxy forwards /v1 to the combined server.
import { supabase } from "./supabase";

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message || code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError("UNAUTHORIZED", "Bạn cần đăng nhập.", 401);
  return { Authorization: `Bearer ${token}` };
}

export interface ApiOptions {
  body?: unknown;
  /** Idempotency-Key header (money/refund/quick-create POSTs — NFR-02). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

async function request<T>(method: string, path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(await authHeader()),
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("OFFLINE", "Không kết nối được máy chủ.", 0);
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try { json = JSON.parse(text); } catch { /* non-json */ }
  }

  if (!res.ok) {
    const j = (json ?? {}) as { code?: string; message?: string; details?: unknown };
    throw new ApiError(j.code || "INTERNAL", j.message || "Có lỗi xảy ra.", res.status, j.details);
  }
  return json as T;
}

/** A fresh idempotency key for a new money/refund action (reused across retries). */
export function newIdempotencyKey(): string {
  return (crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

/** Fetch an authenticated text/HTML resource (the receipt). */
export async function fetchText(path: string): Promise<string> {
  const res = await fetch(path, { headers: await authHeader() });
  if (!res.ok) throw new ApiError("INTERNAL", "Không tải được nội dung.", res.status);
  return res.text();
}

// ── Typed API surface ────────────────────────────────────────────────────────
export interface ApiProduct {
  id: string; name: string; sku: string | null; barcode: string | null;
  unitCode: string; salePrice: number; trackInventory: boolean; allowDiscount: boolean;
  isActive: boolean; categoryId: string | null; onHand: number | null; lowStockThreshold: number | null;
}
export interface CartItemInput { productId?: string | null; quantity: number | string; name?: string; unitPrice?: number; unitCode?: string; note?: string | null; }
export interface AdjustmentInput { scope: "line" | "order"; kind: "fixed" | "percent"; rate?: number; amount?: number; lineNo?: number; reasonCode?: string; note?: string; }

export interface PreviewLine { lineNo: number; name: string; unitCode: string; unitPrice: number; quantity: number; grossAmount: number; discountAmount: number; netAmount: number; }
export interface PreviewResult {
  subtotalAmount: number; discountAmount: number; totalAmount: number; pricingVersion: string;
  lines: PreviewLine[]; warnings: { code: string; lineNo: number; productId: string; available: number }[]; canCheckout: boolean;
}

export interface OrderItem { id: string; productId: string | null; lineNo: number; name: string; sku: string | null; unitCode: string; unitPrice: number; quantity: number; grossAmount: number; discountAmount: number; netAmount: number; note: string | null; }
export interface OrderPayment { id: string; method: string; status: string; amount: number; cashReceived: number | null; changeDue: number | null; provider: string | null; providerPaymentId: string | null; qrPayload: string | null; checkoutUrl: string | null; expiresAt: string | null; paidAt: string | null; }
export interface OrderReturn { id: string; returnNumber: string; status: string; reasonCode: string; refundTotal: number; completedAt: string | null; createdAt: string; items?: unknown[]; refunds?: unknown[]; }
export interface OrderView {
  order: { id: string; orderNumber: string; clientRequestId: string; status: string; version: number; businessDate: string; subtotalAmount: number; discountAmount: number; totalAmount: number; note: string | null; paidAt: string | null; cancelledAt: string | null; createdAt: string; updatedAt: string; };
  items: OrderItem[]; adjustments: unknown[]; payments: OrderPayment[]; returns: OrderReturn[];
}

export const api = {
  listProducts: (merchantId: string, params: { search?: string; category?: string; barcode?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.category) qs.set("category", params.category);
    if (params.barcode) qs.set("barcode", params.barcode);
    const q = qs.toString();
    return request<{ products: ApiProduct[] }>("GET", `/v1/merchants/${merchantId}/products${q ? "?" + q : ""}`);
  },
  quickCreateProduct: (merchantId: string, body: Record<string, unknown>, idempotencyKey: string) =>
    request<{ product: ApiProduct; suggestion: unknown; idempotentReplay: boolean }>("POST", `/v1/merchants/${merchantId}/products/quick`, { body, idempotencyKey }),
  preview: (merchantId: string, body: { items: CartItemInput[]; adjustments?: AdjustmentInput[] }) =>
    request<PreviewResult>("POST", `/v1/merchants/${merchantId}/sales/preview`, { body }),
  createOrder: (merchantId: string, body: { clientRequestId: string; items: CartItemInput[]; adjustments?: AdjustmentInput[]; note?: string }) =>
    request<OrderView>("POST", `/v1/merchants/${merchantId}/orders`, { body }),
  updateOrder: (orderId: string, body: { expectedVersion: number; items: CartItemInput[]; adjustments?: AdjustmentInput[]; note?: string }) =>
    request<OrderView>("PATCH", `/v1/orders/${orderId}`, { body }),
  getOrder: (orderId: string) => request<OrderView>("GET", `/v1/orders/${orderId}`),
  listOrders: (merchantId: string, params: { businessDate?: string; status?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.businessDate) qs.set("businessDate", params.businessDate);
    if (params.status) qs.set("status", params.status);
    const q = qs.toString();
    return request<{ orders: (OrderView["order"] & { itemCount: number; paidMethod: string | null })[] }>("GET", `/v1/merchants/${merchantId}/orders${q ? "?" + q : ""}`);
  },
  activeDraft: (merchantId: string) => request<OrderView | { order: null }>("GET", `/v1/merchants/${merchantId}/active-draft`),
  cancelOrder: (orderId: string, expectedVersion: number) => request<OrderView>("POST", `/v1/orders/${orderId}/cancel`, { body: { expectedVersion } }),
  lockOrder: (orderId: string, expectedVersion: number) => request<OrderView>("POST", `/v1/orders/${orderId}/lock`, { body: { expectedVersion } }),
  unlockOrder: (orderId: string, expectedVersion: number) => request<OrderView>("POST", `/v1/orders/${orderId}/unlock`, { body: { expectedVersion } }),
  payCash: (body: { merchantId: string; orderId: string; expectedVersion: number; cashReceived: number }, idempotencyKey: string) =>
    request<{ orderId: string; paymentId: string; status: string; changeDue: number; receiptId?: string }>("POST", "/v1/payments/cash", { body, idempotencyKey }),
  createQr: (body: { merchantId: string; orderId: string; expectedVersion: number }, idempotencyKey: string) =>
    request<{ paymentId: string; orderId: string; status: string; amount: number; qrPayload: string | null; checkoutUrl: string | null; expiresAt: string | null; accountName?: string | null; accountMasked?: string | null }>("POST", "/v1/payments/qr", { body, idempotencyKey }),
  getPayment: (paymentId: string, reconcile = false) =>
    request<{ paymentId: string; orderId: string; method: string; status: string; amount: number; changeDue: number | null; qrPayload: string | null; expiresAt: string | null; paidAt: string | null }>("GET", `/v1/payments/${paymentId}${reconcile ? "?reconcile=1" : ""}`),
  cancelPayment: (paymentId: string, reason?: string) =>
    request<{ paymentId: string; status: string; orderId: string }>("POST", `/v1/payments/${paymentId}/cancel`, { body: { reason } }),
  returnsPreview: (orderId: string, items: { orderItemId: string; quantity: number; condition: string }[]) =>
    request<{ lines: { orderItemId: string; name: string; quantity: number; refundAmount: number; condition: string }[]; refundTotal: number; maxRefundable: number; canRefund: boolean }>("POST", `/v1/orders/${orderId}/returns/preview`, { body: { items } }),
  createReturn: (orderId: string, body: { items: { orderItemId: string; quantity: number; condition: string }[]; reasonCode: string; note?: string; refundMethod: string }, idempotencyKey: string) =>
    request<{ returnId: string; returnNumber: string; refundId: string; refundStatus: string; refundAmount: number; method: string }>("POST", `/v1/orders/${orderId}/returns`, { body, idempotencyKey }),
  confirmRefund: (refundId: string, reference?: string) =>
    request<{ refundId: string; status: string; orderId: string }>("POST", `/v1/refunds/${refundId}/confirm`, { body: { reference } }),
  receiptUrl: (orderId: string) => `/v1/orders/${orderId}/receipt`,
};
