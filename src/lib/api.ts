// Client → Functional 03 server API. Every call attaches the current Supabase
// access token as a Bearer (the server derives the trusted user id from it, never
// the client). Errors follow the spec 11.1 contract and are surfaced as typed
// ApiError so screens can switch on `.code` (VERSION_CONFLICT, PRICE_CHANGED,
// INSUFFICIENT_STOCK, PAYMENT_ALREADY_SUCCEEDED, …). Same-origin in production;
// the Vite dev proxy forwards /v1 to the combined server.
import { supabase } from "./supabase";
import type { Invoice, InvoiceListItem, EligibleOrder, ValidateResult, InvoiceBuyer } from "./einvoice";
import type {
  ClosingListResult, DraftDetail, ClosingDetail, ClosingRevision, ClosingAttentionItem,
  ClosingPreview, ClosingConfirmResult, CountMode,
} from "./closing";

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

/** Fetch an authenticated file (e.g. a report CSV) as a Blob for download. */
export async function fetchBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { headers: await authHeader() });
  if (!res.ok) throw new ApiError("INTERNAL", "Không tải được tệp.", res.status);
  return res.blob();
}

// ── Typed API surface ────────────────────────────────────────────────────────
export interface ApiProduct {
  id: string; name: string; sku: string | null; barcode: string | null;
  unitCode: string; salePrice: number; trackInventory: boolean; allowDiscount: boolean;
  isActive: boolean; categoryId: string | null; onHand: number | null; lowStockThreshold: number | null;
  // Functional 04 additive fields (present from the catalog API; optional so older
  // call sites keep compiling).
  searchName?: string; productType?: "goods" | "service"; status?: "active" | "inactive" | "archived";
  categoryName?: string | null; rowVersion?: number; negativeStockPolicy?: "block" | "allow_owner";
  productLowStockThreshold?: number | null; effectiveLowStockThreshold?: number | null;
}

export interface CatalogListResult { products: ApiProduct[]; hasMore: boolean; nextOffset: number | null; }
export interface Category { id: string; name: string; sortOrder?: number; activeCount?: number; }
export interface ProductPriceHistoryEntry { priceVnd: number; effectiveFrom: string; changedBy: string; }
export interface ProductAuditEntry { action: string; before: Record<string, unknown>; after: Record<string, unknown>; actorUserId: string | null; createdAt: string; }
export interface ProductMovementEntry { movementType: string; quantityDelta: number; balanceAfter: number; reasonCode: string | null; createdAt: string; }
export interface ProductDetailResult {
  product: ApiProduct;
  priceHistory: ProductPriceHistoryEntry[];
  auditEvents: ProductAuditEntry[];
  movements: ProductMovementEntry[];
}
export interface CategorySuggestion { categoryId: string | null; suggestedName: string | null; confidence: number; preselect: boolean; reason: string; }
export interface AiDraftFields { displayName: string | null; productType: "goods" | "service"; unitCode: string | null; priceVnd: number | null; }
export interface AiImageDraft {
  suggestionId: string; draftId: string; inputKind: "image";
  fields: AiDraftFields;
  fieldConfidence: { displayName: number | null; unitCode: number | null; priceVnd: number | null };
  warnings: string[];
  category: CategorySuggestion;
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
  // ── Functional 04 catalog ──────────────────────────────────────────────────
  catalogList: (merchantId: string, params: { search?: string; category?: string; type?: string; status?: string; includeArchived?: boolean; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.category) qs.set("category", params.category);
    if (params.type) qs.set("type", params.type);
    if (params.status) qs.set("status", params.status);
    if (params.includeArchived) qs.set("includeArchived", "1");
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return request<CatalogListResult>("GET", `/v1/merchants/${merchantId}/products${q ? "?" + q : ""}`);
  },
  getProduct: (merchantId: string, productId: string) =>
    request<ProductDetailResult>("GET", `/v1/merchants/${merchantId}/products/${productId}`),
  createProduct: (merchantId: string, body: Record<string, unknown>, idempotencyKey: string) =>
    request<{ product: ApiProduct; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/products`, { body, idempotencyKey }),
  updateProduct: (merchantId: string, productId: string, body: Record<string, unknown>) =>
    request<{ product: ApiProduct; changed: boolean }>("PATCH", `/v1/merchants/${merchantId}/products/${productId}`, { body }),
  setProductStatus: (merchantId: string, productId: string, action: "activate" | "deactivate" | "archive", expectedVersion: number, reason?: string) =>
    request<{ product: ApiProduct; changed: boolean }>("POST", `/v1/merchants/${merchantId}/products/${productId}/status`, { body: { action, expectedVersion, reason } }),
  lookupBarcode: (merchantId: string, code: string) =>
    request<{ product: ApiProduct }>("GET", `/v1/merchants/${merchantId}/products/barcode/${encodeURIComponent(code)}`),
  listCategories: (merchantId: string) =>
    request<{ categories: Category[] }>("GET", `/v1/merchants/${merchantId}/categories`),
  createCategory: (merchantId: string, name: string) =>
    request<{ category: Category; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/categories`, { body: { name } }),
  renameCategory: (merchantId: string, categoryId: string, name: string) =>
    request<{ category: Category }>("PATCH", `/v1/merchants/${merchantId}/categories/${categoryId}`, { body: { name } }),
  aiPreviewImage: (merchantId: string, draftId: string, image: string, mimeType: string) =>
    request<AiImageDraft>("POST", `/v1/merchants/${merchantId}/products/ai/preview`, { body: { draftId, inputKind: "image", image, mimeType } }),
  aiSuggestCategory: (merchantId: string, draftId: string, name: string) =>
    request<{ draftId: string; inputKind: "category"; category: CategorySuggestion }>("POST", `/v1/merchants/${merchantId}/products/ai/preview`, { body: { draftId, inputKind: "category", name } }),
  aiConfirm: (merchantId: string, suggestionId: string, decision: "accept" | "reject", acceptedFields?: string[]) =>
    request<{ suggestionId: string; status: string }>("POST", `/v1/merchants/${merchantId}/products/ai/${suggestionId}/confirm`, { body: { decision, acceptedFields } }),
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
  outstandingBill: (merchantId: string, excludeOrderId?: string) =>
    request<OrderView | { order: null }>("GET", `/v1/merchants/${merchantId}/outstanding-bill${excludeOrderId ? `?excludeOrderId=${encodeURIComponent(excludeOrderId)}` : ""}`),
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
  // ── Functional 05 inventory ────────────────────────────────────────────────
  inventoryList: (merchantId: string, params: { search?: string; filter?: InventoryFilter; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.filter && params.filter !== "all") qs.set("filter", params.filter);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return request<InventoryOverview>("GET", `/v1/merchants/${merchantId}/inventory${q ? "?" + q : ""}`);
  },
  inventoryLedger: (merchantId: string, productId: string, params: { limit?: number; before?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.before) qs.set("before", params.before);
    const q = qs.toString();
    return request<LedgerResult>("GET", `/v1/merchants/${merchantId}/inventory/${productId}${q ? "?" + q : ""}`);
  },
  inventoryReconciliation: (merchantId: string) =>
    request<{ findings: ReconFinding[] }>("GET", `/v1/merchants/${merchantId}/inventory/reconciliation`),
  adjustPreview: (merchantId: string, body: AdjustInput) =>
    request<AdjustPreview>("POST", `/v1/merchants/${merchantId}/inventory/adjustments/preview`, { body }),
  adjustPost: (merchantId: string, body: AdjustInput & { expectedBalanceVersion?: number }, idempotencyKey: string) =>
    request<AdjustResult>("POST", `/v1/merchants/${merchantId}/inventory/adjustments`, { body, idempotencyKey }),
  reverseMovement: (merchantId: string, movementId: string, body: { reasonCode?: string; note?: string }, idempotencyKey: string) =>
    request<ReversalResult>("POST", `/v1/merchants/${merchantId}/inventory/movements/${movementId}/reverse`, { body, idempotencyKey }),
  countCreate: (merchantId: string, body: { name?: string; blindCount?: boolean; scope: CountScope; businessDate?: string }, idempotencyKey: string) =>
    request<{ session: CountSessionSummary; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/inventory-counts`, { body, idempotencyKey }),
  countList: (merchantId: string) =>
    request<{ sessions: CountSessionSummary[] }>("GET", `/v1/merchants/${merchantId}/inventory-counts`),
  countGet: (merchantId: string, sessionId: string) =>
    request<CountSessionView>("GET", `/v1/merchants/${merchantId}/inventory-counts/${sessionId}`),
  countSaveItems: (merchantId: string, sessionId: string, body: { items: CountItemInput[]; expectedRowVersion?: number }) =>
    request<CountSessionView>("PATCH", `/v1/merchants/${merchantId}/inventory-counts/${sessionId}/items`, { body }),
  countReview: (merchantId: string, sessionId: string) =>
    request<CountSessionView>("POST", `/v1/merchants/${merchantId}/inventory-counts/${sessionId}/review`, { body: {} }),
  countPost: (merchantId: string, sessionId: string, idempotencyKey: string) =>
    request<CountPostResult>("POST", `/v1/merchants/${merchantId}/inventory-counts/${sessionId}/post`, { body: {}, idempotencyKey }),
  countCancel: (merchantId: string, sessionId: string) =>
    request<{ sessionId: string; status: string }>("POST", `/v1/merchants/${merchantId}/inventory-counts/${sessionId}/cancel`, { body: {} }),
  chat: (merchantId: string, messages: ChatTurn[], signal?: AbortSignal) =>
    request<ChatResponse>("POST", "/v1/assistant/chat", { body: { merchantId, messages }, signal }),
  // ── Functional 06 receiving (nhập hàng) ────────────────────────────────────
  listReceipts: (merchantId: string, params: { status?: string; search?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.status && params.status !== "all") qs.set("status", params.status);
    if (params.search) qs.set("search", params.search);
    const q = qs.toString();
    return request<{ receipts: ReceiptSummary[] }>("GET", `/v1/merchants/${merchantId}/receiving/receipts${q ? "?" + q : ""}`);
  },
  createReceipt: (merchantId: string, body: { receivedAt?: string; supplierId?: string | null; supplierName?: string | null; documentId?: string | null; extraCostVnd?: number }, idempotencyKey: string) =>
    request<{ receipt: Receipt; items: ReceiptItem[]; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/receiving/receipts`, { body, idempotencyKey }),
  getReceipt: (merchantId: string, receiptId: string) =>
    request<ReceiptDetail>("GET", `/v1/merchants/${merchantId}/receiving/receipts/${receiptId}`),
  updateReceipt: (merchantId: string, receiptId: string, body: Record<string, unknown>) =>
    request<{ receipt: Receipt }>("PATCH", `/v1/merchants/${merchantId}/receiving/receipts/${receiptId}`, { body }),
  putReceiptItems: (merchantId: string, receiptId: string, body: { items: ReceiptItemInput[]; expectedRowVersion?: number }) =>
    request<{ receipt: Receipt; items: ReceiptItem[] }>("PUT", `/v1/merchants/${merchantId}/receiving/receipts/${receiptId}/items`, { body }),
  previewReceipt: (merchantId: string, receiptId: string) =>
    request<ReceiptPreview>("POST", `/v1/merchants/${merchantId}/receiving/receipts/${receiptId}/preview`, { body: {} }),
  postReceipt: (merchantId: string, receiptId: string, body: { expectedReceiptVersion?: number }, idempotencyKey: string) =>
    request<ReceiptPostResult>("POST", `/v1/merchants/${merchantId}/receiving/receipts/${receiptId}/post`, { body, idempotencyKey }),
  cancelReceipt: (merchantId: string, receiptId: string, expectedVersion?: number) =>
    request<{ receiptId: string; status: string }>("POST", `/v1/merchants/${merchantId}/receiving/receipts/${receiptId}/cancel`, { body: { expectedVersion } }),
  reverseReceipt: (merchantId: string, receiptId: string, body: { note?: string }, idempotencyKey: string) =>
    request<{ receiptId: string; status: string; reversedMovements: unknown[]; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/receiving/receipts/${receiptId}/reverse`, { body, idempotencyKey }),
  listSuppliers: (merchantId: string, search?: string) => {
    const q = search ? `?search=${encodeURIComponent(search)}` : "";
    return request<{ suppliers: Supplier[] }>("GET", `/v1/merchants/${merchantId}/receiving/suppliers${q}`);
  },
  createSupplier: (merchantId: string, body: { name: string; phone?: string; note?: string }) =>
    request<{ supplier: Supplier }>("POST", `/v1/merchants/${merchantId}/receiving/suppliers`, { body }),
  uploadDocument: (merchantId: string, body: { image: string; mimeType: string; documentNumber?: string; extract?: boolean; force?: boolean }) =>
    request<DocumentUploadResult>("POST", `/v1/merchants/${merchantId}/receiving/documents`, { body }),
  extractDocument: (merchantId: string, documentId: string) =>
    request<DocumentExtraction>("POST", `/v1/merchants/${merchantId}/receiving/documents/${documentId}/extract`, { body: {} }),
  documentUrl: (merchantId: string, documentId: string) =>
    request<{ url: string; expiresIn: number }>("GET", `/v1/merchants/${merchantId}/receiving/documents/${documentId}/url`),
  // ── Functional 07 expenses (ghi nhận chi phí) ──────────────────────────────
  expenseCategories: (merchantId: string) =>
    request<{ categories: ExpenseCategory[] }>("GET", `/v1/merchants/${merchantId}/expense-categories`),
  listExpenses: (merchantId: string, params: { month?: string; status?: string; category?: string; search?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.month) qs.set("month", params.month);
    if (params.status && params.status !== "all") qs.set("status", params.status);
    if (params.category) qs.set("category", params.category);
    if (params.search) qs.set("search", params.search);
    const q = qs.toString();
    return request<ExpenseListResult>("GET", `/v1/merchants/${merchantId}/expenses${q ? "?" + q : ""}`);
  },
  createExpense: (merchantId: string, body: CreateExpenseInput, idempotencyKey: string) =>
    request<ExpenseDetail & { replayed?: boolean }>("POST", `/v1/merchants/${merchantId}/expenses`, { body: body as unknown as Record<string, unknown>, idempotencyKey }),
  getExpense: (merchantId: string, id: string) =>
    request<ExpenseDetail>("GET", `/v1/merchants/${merchantId}/expenses/${id}`),
  updateExpense: (merchantId: string, id: string, body: CreateExpenseInput & { expectedVersion?: number }) =>
    request<ExpenseDetail>("PATCH", `/v1/merchants/${merchantId}/expenses/${id}`, { body: body as unknown as Record<string, unknown> }),
  postExpense: (merchantId: string, id: string, body: PostExpenseInput, idempotencyKey: string) =>
    request<PostExpenseResult>("POST", `/v1/merchants/${merchantId}/expenses/${id}/post`, { body: body as unknown as Record<string, unknown>, idempotencyKey }),
  reverseExpense: (merchantId: string, id: string, body: { reason?: string }, idempotencyKey: string) =>
    request<{ expenseId: string; status: string; reversalEventId: string; replayed?: boolean }>("POST", `/v1/merchants/${merchantId}/expenses/${id}/reverse`, { body, idempotencyKey }),
  expenseDuplicates: (merchantId: string, id: string) =>
    request<{ findings: ExpenseDuplicateFinding[] }>("GET", `/v1/merchants/${merchantId}/expenses/${id}/duplicates`),
  decideDuplicate: (merchantId: string, id: string, findingId: string, decision: "dismissed" | "confirmed") =>
    request<{ findingId: string; status: string }>("POST", `/v1/merchants/${merchantId}/expenses/${id}/duplicate-decision`, { body: { findingId, decision } }),
  aiExpensePreview: (merchantId: string, image: string, mimeType: string) =>
    request<AiExpensePreviewResult>("POST", `/v1/merchants/${merchantId}/expenses/ai/preview`, { body: { image, mimeType } }),
  // ── Functional 08 documents (Hộp chứng từ) ──────────────────────────────────
  documentsList: (merchantId: string, params: DocListParams = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.type) qs.set("type", params.type);
    if (params.linked && params.linked !== "all") qs.set("linked", params.linked);
    if (params.month) qs.set("month", params.month);
    if (params.includeArchived) qs.set("includeArchived", "1");
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return request<DocListResult>("GET", `/v1/merchants/${merchantId}/documents${q ? "?" + q : ""}`);
  },
  documentGet: (merchantId: string, id: string) =>
    request<DocDetailResult>("GET", `/v1/merchants/${merchantId}/documents/${id}`),
  documentContent: (merchantId: string, id: string, action: "preview" | "download" = "preview") =>
    request<DocContent>("GET", `/v1/merchants/${merchantId}/documents/${id}/content?action=${action}`),
  documentUpload: (merchantId: string, body: DocUploadInput, idempotencyKey: string) =>
    request<DocUploadResult>("POST", `/v1/merchants/${merchantId}/documents`, { body, idempotencyKey }),
  documentAddLink: (merchantId: string, id: string, body: { targetType: string; targetId: string; linkType: string }, idempotencyKey: string) =>
    request<{ link: DocLink; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/documents/${id}/links`, { body, idempotencyKey }),
  documentRemoveLink: (merchantId: string, id: string, linkId: string) =>
    request<{ removed: boolean; linkId: string }>("DELETE", `/v1/merchants/${merchantId}/documents/${id}/links/${linkId}`),
  documentLinkCandidates: (merchantId: string, targetType: string, search?: string) => {
    const qs = new URLSearchParams({ targetType });
    if (search) qs.set("search", search);
    return request<{ targetType: string; targetLabel: string; candidates: DocLinkCandidate[] }>("GET", `/v1/merchants/${merchantId}/documents/link-candidates?${qs.toString()}`);
  },
  documentArchive: (merchantId: string, id: string, action: "archive" | "restore", expectedVersion?: number) =>
    request<{ document: DocSummary; changed: boolean }>("POST", `/v1/merchants/${merchantId}/documents/${id}/archive`, { body: { action, expectedVersion } }),
  // ── Functional 09 e-invoice ────────────────────────────────────────────────
  einvoiceList: (merchantId: string, params: { status?: string; search?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.search) qs.set("search", params.search);
    const q = qs.toString();
    return request<{ invoices: EInvoiceListItem[] }>("GET", `/v1/merchants/${merchantId}/e-invoices${q ? "?" + q : ""}`);
  },
  einvoiceEligibleOrders: (merchantId: string, params: { search?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    const q = qs.toString();
    return request<{ orders: EInvoiceEligibleOrder[] }>("GET", `/v1/merchants/${merchantId}/orders/invoice-eligible${q ? "?" + q : ""}`);
  },
  einvoiceCreate: (merchantId: string, body: { orderId: string; buyerKind?: string }, idempotencyKey: string) =>
    request<{ invoice: EInvoice; existing: boolean; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/e-invoices`, { body, idempotencyKey }),
  einvoiceGet: (merchantId: string, invoiceId: string) =>
    request<EInvoice>("GET", `/v1/merchants/${merchantId}/e-invoices/${invoiceId}`),
  einvoiceSaveBuyer: (merchantId: string, invoiceId: string, buyer: EInvoiceBuyerInput, expectedVersion: number) =>
    request<EInvoice>("PATCH", `/v1/merchants/${merchantId}/e-invoices/${invoiceId}/buyer`, { body: { buyer, expectedVersion } }),
  einvoiceValidate: (merchantId: string, invoiceId: string, expectedVersion: number) =>
    request<EInvoiceValidateResult>("POST", `/v1/merchants/${merchantId}/e-invoices/${invoiceId}/validate`, { body: { expectedVersion } }),
  einvoiceSubmit: (merchantId: string, invoiceId: string, body: { expectedVersion: number; acknowledgements: { buyer_reviewed: boolean; amounts_reviewed: boolean } }, idempotencyKey: string) =>
    request<{ invoiceId: string; submissionId: string | null; status: string; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/e-invoices/${invoiceId}/submit`, { body, idempotencyKey }),
  einvoiceStatus: (merchantId: string, invoiceId: string, reconcile = false) =>
    request<{ id: string; status: string; providerInvoiceRef: string | null; rowVersion: number; submissions: unknown[]; events: unknown[] }>("GET", `/v1/merchants/${merchantId}/e-invoices/${invoiceId}/status${reconcile ? "?reconcile=1" : ""}`),
  einvoiceRetryDraft: (merchantId: string, invoiceId: string, idempotencyKey: string) =>
    request<{ invoice: EInvoice; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/e-invoices/${invoiceId}/retry-draft`, { body: {}, idempotencyKey }),
  einvoiceCreateRelation: (merchantId: string, invoiceId: string, body: { relationType: "adjustment" | "replacement"; reason: string }, idempotencyKey: string) =>
    request<{ invoice: EInvoice; relationType: string; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/e-invoices/${invoiceId}/relations`, { body, idempotencyKey }),
  einvoiceArtifactUrl: (merchantId: string, invoiceId: string, type: "xml" | "pdf") =>
    `/v1/merchants/${merchantId}/e-invoices/${invoiceId}/artifacts/${type}`,
  einvoiceSimulate: (merchantId: string, body: { invoiceId: string; decision: "accept" | "reject"; rejectCode?: string }) =>
    request<{ processed: boolean; duplicated: boolean; signatureValid: boolean; status: string | null }>("POST", "/v1/dev/e-invoice/simulate", { body: { merchantId, ...body } }),
  // ── Functional 11 cashbook (sổ thu–chi) ────────────────────────────────────
  cashbookSummary: (merchantId: string, params: { period?: CashbookPeriod; from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.period) qs.set("period", params.period);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    const q = qs.toString();
    return request<CashbookSummary>("GET", `/v1/merchants/${merchantId}/cashbook/summary${q ? "?" + q : ""}`);
  },
  cashbookEntries: (merchantId: string, params: CashbookEntriesQuery = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
    const q = qs.toString();
    return request<CashbookEntriesResult>("GET", `/v1/merchants/${merchantId}/cashbook/entries${q ? "?" + q : ""}`);
  },
  cashbookEntry: (merchantId: string, entryId: string) =>
    request<CashbookEntryDetail>("GET", `/v1/merchants/${merchantId}/cashbook/entries/${entryId}`),
  cashbookReverse: (merchantId: string, entryId: string, body: { reasonCode: string; note?: string }, idempotencyKey: string) =>
    request<{ originalEntryId: string; reversalEntryId: string; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/cashbook/entries/${entryId}/reverse`, { body, idempotencyKey }),
  cashbookReview: (merchantId: string, params: { status?: string; reasonCode?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.reasonCode) qs.set("reasonCode", params.reasonCode);
    const q = qs.toString();
    return request<{ items: CashbookReviewItem[] }>("GET", `/v1/merchants/${merchantId}/cashbook/review${q ? "?" + q : ""}`);
  },
  cashbookGetReview: (merchantId: string, reviewId: string) =>
    request<{ item: CashbookReviewItem }>("GET", `/v1/merchants/${merchantId}/cashbook/review/${reviewId}`),
  cashbookPatchReview: (merchantId: string, reviewId: string, body: CashbookDraftFields & { expectedRowVersion?: number }) =>
    request<CashbookReviewItem>("PATCH", `/v1/merchants/${merchantId}/cashbook/review/${reviewId}`, { body }),
  cashbookPreviewReview: (merchantId: string, reviewId: string) =>
    request<CashbookReviewPreview>("POST", `/v1/merchants/${merchantId}/cashbook/review/${reviewId}/preview`, { body: {} }),
  cashbookPostReview: (merchantId: string, reviewId: string, body: { expectedRowVersion?: number }, idempotencyKey: string) =>
    request<{ entryId: string; status: string; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/cashbook/review/${reviewId}/post`, { body, idempotencyKey }),
  cashbookExcludeReview: (merchantId: string, reviewId: string, body: { reasonCode: string; note?: string; expectedRowVersion?: number }) =>
    request<{ reviewId: string; status: string; reasonCode: string }>("POST", `/v1/merchants/${merchantId}/cashbook/review/${reviewId}/exclude`, { body }),
  cashbookManualDraft: (merchantId: string, body: CashbookDraftFields, idempotencyKey: string) =>
    request<{ reviewId: string; status: string; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/cashbook/manual-drafts`, { body, idempotencyKey }),
  cashbookSync: (merchantId: string, body: { limit?: number } = {}) =>
    request<{ scanned: number; posted: number; review: number; replayed: number; skipped: number }>("POST", `/v1/merchants/${merchantId}/cashbook/sync`, { body }),
  // ── Functional 12 reconciliation (đối soát) ────────────────────────────────
  reconSummary: (merchantId: string) =>
    request<ReconSummary>("GET", `/v1/merchants/${merchantId}/reconciliation/summary`),
  reconRun: (merchantId: string, body: { scope?: unknown; dryRun?: boolean }, idempotencyKey: string) =>
    request<{ run: ReconRun; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/reconciliation/runs`, { body, idempotencyKey }),
  reconRuns: (merchantId: string, limit?: number) =>
    request<{ runs: ReconRun[] }>("GET", `/v1/merchants/${merchantId}/reconciliation/runs${limit ? `?limit=${limit}` : ""}`),
  reconRunGet: (merchantId: string, runId: string) =>
    request<{ run: ReconRun }>("GET", `/v1/merchants/${merchantId}/reconciliation/runs/${runId}`),
  reconIssues: (merchantId: string, params: { status?: string; family?: string; impact?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.family) qs.set("family", params.family);
    if (params.impact) qs.set("impact", params.impact);
    const q = qs.toString();
    return request<{ issues: ReconIssue[] }>("GET", `/v1/merchants/${merchantId}/reconciliation/issues${q ? "?" + q : ""}`);
  },
  reconIssue: (merchantId: string, issueId: string) =>
    request<ReconIssueDetail>("GET", `/v1/merchants/${merchantId}/reconciliation/issues/${issueId}`),
  reconReview: (merchantId: string, issueId: string, expectedVersion: number) =>
    request<ReconIssueDetail>("POST", `/v1/merchants/${merchantId}/reconciliation/issues/${issueId}/review`, { body: { expectedVersion } }),
  reconAction: (merchantId: string, issueId: string, body: { actionType: string; intentId: string; reason?: unknown; expectedVersion?: number }) =>
    request<ReconIssueDetail>("POST", `/v1/merchants/${merchantId}/reconciliation/issues/${issueId}/action`, { body }),
  reconIgnore: (merchantId: string, issueId: string, body: { reasonCode: string; note?: string; intentId: string; expectedVersion?: number }) =>
    request<ReconIssueDetail>("POST", `/v1/merchants/${merchantId}/reconciliation/issues/${issueId}/ignore`, { body }),

  // ── Functional 13 reports ────────────────────────────────────────────────────
  reportBuild: (merchantId: string, body: ReportBuildInput, idempotencyKey?: string) =>
    request<ReportBuildResult>("POST", `/v1/merchants/${merchantId}/reports/snapshots`, { body, idempotencyKey }),
  reportList: (merchantId: string, limit = 40) =>
    request<{ snapshots: ReportListItem[] }>("GET", `/v1/merchants/${merchantId}/reports/snapshots?limit=${limit}`),
  reportGet: (merchantId: string, snapshotId: string) =>
    request<ReportSnapshotDto>("GET", `/v1/merchants/${merchantId}/reports/snapshots/${snapshotId}`),
  reportDrilldown: (merchantId: string, snapshotId: string, params: { metric: string; date?: string; channel?: string; categoryId?: string; productId?: string; limit?: number }) => {
    const qs = new URLSearchParams({ metric: params.metric });
    if (params.date) qs.set("date", params.date);
    if (params.channel) qs.set("channel", params.channel);
    if (params.categoryId) qs.set("categoryId", params.categoryId);
    if (params.productId) qs.set("productId", params.productId);
    if (params.limit) qs.set("limit", String(params.limit));
    return request<ReportDrilldown>("GET", `/v1/merchants/${merchantId}/reports/snapshots/${snapshotId}/drilldown?${qs.toString()}`);
  },
  reportCompare: (merchantId: string, baseId: string, compareId: string) =>
    request<ReportCompare>("POST", `/v1/merchants/${merchantId}/reports/compare`, { body: { baseId, compareId } }),
  reportCreateExport: (merchantId: string, snapshotId: string) =>
    request<ReportExportResult>("POST", `/v1/merchants/${merchantId}/reports/snapshots/${snapshotId}/exports`, { body: { exportType: "csv" } }),
  // ── Functional 14 chốt tiền cuối ngày (end-of-day cash closing) ─────────────
  closingsList: (merchantId: string, params: { from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    const q = qs.toString();
    return request<ClosingListResult>("GET", `/v1/merchants/${merchantId}/closings${q ? "?" + q : ""}`);
  },
  closingPrepare: (merchantId: string, businessDate?: string) =>
    request<DraftDetail>("POST", `/v1/merchants/${merchantId}/closings/prepare`, { body: { businessDate } }),
  closingGet: (merchantId: string, closingId: string) =>
    request<ClosingDetail>("GET", `/v1/merchants/${merchantId}/closings/${closingId}`),
  closingRevisions: (merchantId: string, closingId: string) =>
    request<{ revisions: ClosingRevision[] }>("GET", `/v1/merchants/${merchantId}/closings/${closingId}/revisions`),
  closingScanLate: (merchantId: string, closingId: string) =>
    request<{ detected: number; open?: number; status?: string; items: ClosingAttentionItem[] }>("POST", `/v1/merchants/${merchantId}/closings/${closingId}/attention/scan`, { body: {} }),
  closingDraftGet: (merchantId: string, draftId: string) =>
    request<DraftDetail>("GET", `/v1/merchants/${merchantId}/closing-drafts/${draftId}`),
  closingSaveCount: (merchantId: string, draftId: string, body: { clientCountId: string; mode: CountMode; countedTotalVnd?: number; denominations?: { denominationVnd: number; quantity: number }[] }) =>
    request<DraftDetail>("POST", `/v1/merchants/${merchantId}/closing-drafts/${draftId}/counts`, { body }),
  closingPreview: (merchantId: string, draftId: string, body: { countVersion?: number; reasonCode?: string | null; reasonNote?: string | null } = {}) =>
    request<ClosingPreview>("POST", `/v1/merchants/${merchantId}/closing-drafts/${draftId}/preview`, { body }),
  closingConfirm: (merchantId: string, draftId: string, body: { previewHash: string; countVersion: number; reasonCode?: string | null; reasonNote?: string | null; responsibilityConfirmed: boolean }, idempotencyKey: string) =>
    request<ClosingConfirmResult>("POST", `/v1/merchants/${merchantId}/closing-drafts/${draftId}/confirm`, { body, idempotencyKey }),
  closingResolveAttention: (merchantId: string, attentionId: string, body: { decision: "dismissed"; note?: string }) =>
    request<{ attentionId: string; status: string; openRemaining?: number }>("POST", `/v1/merchants/${merchantId}/closing-attention/${attentionId}/resolve`, { body }),
  // ── Functional 15 sổ kế toán & dữ liệu thuế ────────────────────────────────
  taxAccountingOverview: (merchantId: string, period?: string) =>
    request<TaxOverview>("GET", `/v1/merchants/${merchantId}/accounting/overview${period ? `?period=${period}` : ""}`),
  taxCatalog: (merchantId: string) =>
    request<TaxCatalog>("GET", `/v1/merchants/${merchantId}/accounting/catalog`),
  taxSync: (merchantId: string, body: { from?: string; to?: string } = {}) =>
    request<{ scanned: number; mapped: number; replayed: number; skipped: number; records: number; failed?: number; errors?: string[] }>("POST", `/v1/merchants/${merchantId}/accounting/sync`, { body }),
  taxBookLedger: (merchantId: string, bookCode: string, params: { period?: string; snapshotId?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.snapshotId) qs.set("snapshotId", params.snapshotId);
    else if (params.period) qs.set("period", params.period);
    const q = qs.toString();
    return request<TaxBookLedger>("GET", `/v1/merchants/${merchantId}/accounting/books/${bookCode}${q ? "?" + q : ""}`);
  },
  taxRecord: (merchantId: string, recordId: string) =>
    request<TaxRecordDetail>("GET", `/v1/merchants/${merchantId}/accounting/records/${recordId}`),
  taxPeriodPreview: (merchantId: string, period: string) =>
    request<TaxLockPreview>("POST", `/v1/merchants/${merchantId}/accounting/periods/preview`, { body: { period } }),
  taxPeriodLock: (merchantId: string, body: { period: string; previewHash: string; asOf: string; responsibilityConfirmed: boolean }, idempotencyKey: string) =>
    request<{ snapshotId: string; versionNo: number; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/accounting/periods/lock`, { body, idempotencyKey }),
  taxSnapshots: (merchantId: string, period?: string) =>
    request<TaxSnapshotList>("GET", `/v1/merchants/${merchantId}/accounting/snapshots${period ? `?period=${period}` : ""}`),
  taxSnapshot: (merchantId: string, snapshotId: string) =>
    request<{ snapshot: TaxSnapshot }>("GET", `/v1/merchants/${merchantId}/accounting/snapshots/${snapshotId}`),
  taxBuildPackage: (merchantId: string, snapshotId: string, idempotencyKey: string) =>
    request<{ packageId: string; replayed: boolean; contentHash: string }>("POST", `/v1/merchants/${merchantId}/tax-data/packages`, { body: { snapshotId }, idempotencyKey }),
  taxPackage: (merchantId: string, packageId: string) =>
    request<TaxPackageResult>("GET", `/v1/merchants/${merchantId}/tax-data/packages/${packageId}`),
  taxCreateExport: (merchantId: string, body: { snapshotId: string; scope: TaxExportScope; format?: string }) =>
    request<{ exportId: string; objectKey: string; contentHash: string; format: string; replayed: boolean }>("POST", `/v1/merchants/${merchantId}/accounting/exports`, { body }),
  taxListExports: (merchantId: string, snapshotId: string) =>
    request<{ exports: TaxExport[] }>("GET", `/v1/merchants/${merchantId}/accounting/snapshots/${snapshotId}/exports`),
  taxExportDownloadUrl: (merchantId: string, exportId: string) =>
    `/v1/merchants/${merchantId}/accounting/exports/${exportId}/download`,
};

// ── Functional 09 e-invoice (types from lib/einvoice, re-aliased for the API) ──
export type EInvoice = Invoice;
export type EInvoiceListItem = InvoiceListItem;
export type EInvoiceEligibleOrder = EligibleOrder;
export type EInvoiceValidateResult = ValidateResult;
export type { InvoiceBuyer };
export interface EInvoiceBuyerInput { kind: "individual" | "organization"; name?: string | null; taxCode?: string | null; address?: string | null; email?: string | null; }

// ── Functional 13 report types (mirror the server DTO) ───────────────────────
export type Coverage = "complete" | "partial" | "unavailable";
export interface ReportBuildInput { preset?: "day" | "week" | "month" | "quarter"; period?: { start: string; end: string }; timezone?: string; scope?: Record<string, unknown>; rebuild?: boolean; }
export interface ReportSnapshotHeader {
  id: string; merchantId: string; periodStart: string; periodEnd: string; periodLabel: string;
  timezone: string; scope: unknown; scopeHash: string; formulaVersion: string; asOf: string | null;
  status: string; revision: number; supersedesId: string | null; contentHash: string | null;
  createdAt: string | null; isLatest: boolean; newer: { id: string; revision: number } | null;
}
export interface ReportSales {
  grossVnd: number; refundVnd: number; netVnd: number; billCount: number; billAvgVnd: number;
  byChannel: { channel: string; label: string; netVnd: number }[];
  byDay: { date: string; netVnd: number }[];
  topProducts: { rank: number; name: string; productId: string | null; revenueVnd: number; qty: number }[];
  topCoverage: Coverage;
}
export interface ReportExpense { totalVnd: number; byCategory: { categoryId: string | null; categoryName: string; totalVnd: number }[]; coverage: Coverage; }
export interface ReportInventory { purchaseVnd: number; damageCount: number; damageQty: number; }
export interface ReportCashflow { cashCollectedVnd: number; expensePaidVnd: number; deltaVnd: number; }
export interface ReportEstimate { valueVnd: number; coverage: Coverage; formula: string; disclosures: string[]; }
export interface ReportCoverageSource { sourceType: string; label: string; expected: number; processed: number; openIssues: number; status: Coverage; freshnessAt: string | null; affectedMetrics: string[]; }
export interface ReportCoverage { overall: Coverage; percent: number; sources: ReportCoverageSource[]; notes: string[]; }
export interface ReportSnapshotDto {
  snapshot: ReportSnapshotHeader;
  sections: { sales: ReportSales; expense: ReportExpense; inventory: ReportInventory; cashflow: ReportCashflow; estimate: ReportEstimate };
  coverage: ReportCoverage;
  metrics: { code: string; label: string; valueVnd: number | null; valueCount: number | null; dimensions: Record<string, unknown>; coverage: Coverage }[];
}
export interface ReportBuildResult { snapshot: ReportSnapshotDto; ready: boolean; created: boolean; revision: number; }
export interface ReportListItem { id: string; periodStart: string; periodEnd: string; periodLabel: string; timezone: string; scopeHash: string; formulaVersion: string; asOf: string | null; status: string; revision: number; contentHash: string | null; createdAt: string | null; netVnd: number | null; days: number; }
export interface ReportDrilldownRow { id: string; label: string; at?: string | null; amountVnd?: number; qty?: number; route: string | null; }
export interface ReportDrilldown { metric: string; label: string; totalVnd: number; totalCount: number; rows: ReportDrilldownRow[]; truncated: boolean; }
export interface ReportCompareRow { code: string; label: string; valueType: "vnd" | "count"; baseValue: number; compareValue: number; delta: number; pct: number | null; }
export interface ReportCompareHeader { id: string; periodLabel: string; periodStart: string; periodEnd: string; asOf: string | null; revision: number; }
export interface ReportCompare { compatible: boolean; reasons?: string[]; base: ReportCompareHeader; compare: ReportCompareHeader; rows?: ReportCompareRow[]; }
export interface ReportExportResult { id: string; snapshotId: string; exportType: string; status: string; replayed: boolean; downloadPath: string; }

// ── AI Assistant (Functional 10) ─────────────────────────────────────────────
export interface ChatTurn { role: "user" | "assistant"; content: string; }
/** A source card / action chip: server resolves an allowlisted key → deep-link. */
export interface ChatLink { key: string; label: string; route: string; }
export interface ChatResponse {
  kind: "answer" | "refusal";
  reply: string;
  sources: ChatLink[];
  actions: ChatLink[];
  mode: "ai" | "fallback";
  model: string | null;
  businessDate: string;
}

// ── Functional 05 inventory ──────────────────────────────────────────────────
export type InventoryFilter = "all" | "low" | "zero" | "negative";
export type StockState = "ok" | "low" | "zero" | "negative";
export interface InventoryLevel {
  productId: string; name: string; sku: string | null; unitCode: string;
  onHand: number; reserved: number; available: number;
  lowStockThreshold: number; rowVersion: number; state: StockState;
}
export interface InventoryOverview {
  products: InventoryLevel[]; hasMore: boolean; nextOffset: number | null;
  summary: { total: number; negative: number; zero: number; low: number };
}
export interface MovementSource { kind: string; label: string | null; route: string | null; }
export interface MovementEntry {
  id: string; movementType: string; quantityDelta: number; balanceAfter: number;
  reasonCode: string | null; note: string | null; createdAt: string;
  actorName: string | null; originalMovementId: string | null; reversed: boolean;
  source: MovementSource | null;
}
export interface LedgerProduct {
  productId: string; name: string; sku: string | null; unitCode: string;
  onHand: number; reserved: number; available: number; lowStockThreshold: number;
  rowVersion: number; negativeStockPolicy: string; state: StockState;
}
export interface LedgerResult {
  product: LedgerProduct; movements: MovementEntry[]; hasMore: boolean; nextCursor: string | null;
  reconciliation: { ledgerQty: number; balanceQty: number; mismatch: boolean };
}
export interface ReconFinding { productId: string; name: string; unitCode: string; balanceQty: number; ledgerQty: number; diff: number; }
export interface AdjustInput { productId: string; direction: "increase" | "decrease"; quantity: number; reasonCode?: string; note?: string; }
export interface AdjustPreview {
  productId: string; name: string; unitCode: string; direction: "increase" | "decrease";
  quantity: number; delta: number; before: number; after: number;
  reasonCode: string | null; note: string | null; currentVersion: number; wouldBlock: boolean;
}
export interface AdjustResult {
  movementId: string; productId: string; name: string; direction: string; quantity: number;
  delta: number; previousBalance: number; balanceAfter: number; rowVersion: number;
  reasonCode: string | null; note: string | null; replayed: boolean;
}
export interface ReversalResult {
  movementId: string; originalMovementId: string; productId: string; delta: number;
  previousBalance?: number; balanceAfter: number; rowVersion?: number; replayed: boolean;
}
export type CountScope = { type: "all" } | { type: "category"; categoryId: string } | { type: "products"; productIds: string[] };
export interface CountSessionSummary {
  id: string; name: string; status: "draft" | "counting" | "review" | "posted" | "cancelled";
  blindCount: boolean; startedAt: string | null; postedAt: string | null; itemCount: number;
  scope?: CountScope; rowVersion?: number;
}
export interface CountItem {
  productId: string; name: string; unitCode: string; countedQty: number | null;
  reasonCode: string | null; note: string | null;
  expectedAtStart?: number; currentOnHand?: number; variance?: number | null;
  deltaFromExpected?: number | null; requiresReason?: boolean; missing?: boolean;
}
export interface CountItemInput { productId: string; countedQty?: number | null; reasonCode?: string | null; note?: string | null; missing?: boolean; }
export interface CountSessionView {
  session: CountSessionSummary; items: CountItem[];
  summary?: { increases: number; decreases: number; unchanged: number; missing: number; counted: number; needsReason: number };
}
export interface CountPostResult {
  sessionId: string; status: string; postedLines: number; replayed?: boolean;
  adjustments: { productId: string; delta: number; before: number; after: number; reasonCode: string }[];
}

// ── Functional 06 receiving ──────────────────────────────────────────────────
export type ReceiptStatusT = "draft" | "extracting" | "review" | "ready" | "posted" | "reversed" | "cancelled";
export interface Receipt {
  id: string; receiptNumber: string; status: ReceiptStatusT; receivedAt: string;
  supplierId: string | null; supplierName: string | null; documentId: string | null; documentNumber: string | null;
  subtotalVnd: number; extraCostVnd: number; grandTotalVnd: number; rowVersion: number;
  createdAt: string; postedAt: string | null;
}
export interface ReceiptSummary extends Receipt { itemCount: number; }
export interface ReceiptItem {
  id: string; productId: string; name: string; unitCode: string;
  quantity: number; unitCostVnd: number; lineTotalVnd: number;
  matchSource: string; matchConfidence: number | null;
}
export interface ReceiptItemInput { productId: string; quantity: number; unitCostVnd: number; matchSource?: string; matchConfidence?: number | null; }
export interface ReceiptAccountingEvent { id: string; eventType: string; amountVnd: number; reviewStatus: string; createdAt: string; }
export interface ReceiptMovement { id: string; productId: string; productName: string; movementType: string; quantityDelta: number; balanceAfter: number; createdAt: string; }
export interface ReceiptDetail {
  receipt: Receipt; items: ReceiptItem[];
  accounting: ReceiptAccountingEvent[] | null; movements: ReceiptMovement[] | null;
}
export interface ReceiptPreviewLine { productId: string; name: string; unitCode: string; quantity: number; unitCostVnd: number; lineTotalVnd: number; before: number; delta: number; after: number; levelVersion: number; }
export interface ReceiptPreview {
  receipt: Receipt; lines: ReceiptPreviewLine[];
  totals: { subtotalVnd: number; extraCostVnd: number; grandTotalVnd: number };
  accountingPreview: { eventType: string; amountVnd: number; reviewStatus: string };
}
export interface ReceiptPostResult {
  receiptId: string; receiptNumber: string; status: string; subtotalVnd: number; grandTotalVnd: number;
  movements: { productId: string; movementId: string; delta: number; before?: number; after: number }[];
  accountingEventId: string | null; rowVersion: number; replayed: boolean;
}
export interface Supplier { id: string; name: string; phone: string | null; note: string | null; }
export interface DuplicateCandidate { receiptId: string; receiptNumber: string; status: string; totalVnd: number; }
export interface ExtractedLine {
  description: string; quantity: number | null; unitCode: string | null; unitCostVnd: number | null; confidence: number | null;
  match?: { productId: string | null; name: string | null; source: string; confidence: number; candidates: { productId: string; name: string; sku: string | null; unitCode: string }[] };
}
export interface DocumentExtraction {
  documentId: string; status: string; errorCode?: string; supplier: string | null; receivedDate: string | null; documentNumber: string | null;
  lines: ExtractedLine[]; totalHintVnd: number | null;
  fieldConfidence: { supplier: number | null; receivedDate: number | null; documentNumber: number | null };
  warnings: string[];
}
export interface DocumentUploadResult {
  documentId: string; objectKey: string; contentHash: string; documentNumber: string | null; capturedAt: string;
  extraction?: DocumentExtraction;
}
// ── Functional 07 expenses ───────────────────────────────────────────────────
export type ExpenseStatus = "draft" | "extracting" | "review" | "ready" | "posted" | "reversed" | "cancelled";
export type PaymentMethod = "cash" | "transfer" | "other";
export interface ExpenseCategory { id: string; code: string; displayName: string; status: "active" | "inactive"; global: boolean; taxHint: unknown | null; }
export interface ExpenseListItem {
  id: string; expenseNumber: string; status: ExpenseStatus; expenseDate: string; payeeName: string | null;
  grandTotalVnd: number; categoryId: string | null; categoryName: string | null; hasDocument: boolean;
  sourceType: string; paymentMethod: PaymentMethod | null; paymentStatus: "unconfirmed" | "confirmed" | "rejected" | null;
}
export interface ExpenseListResult { month: string; expenses: ExpenseListItem[]; summary: { postedTotalVnd: number; postedCount: number }; }
export interface ExpenseHeader {
  id: string; expenseNumber: string; status: ExpenseStatus; expenseDate: string; payeeName: string | null;
  categoryId: string | null; categoryName: string | null; documentId: string | null; sourceType: string; sourceId: string | null;
  subtotalVnd: number; taxAmountVnd: number; grandTotalVnd: number; rowVersion: number;
  createdAt: string; postedAt: string | null; reversedAt: string | null;
}
export interface ExpenseItemRow { id: string; description: string; quantity: number; unitCostVnd: number; lineTotalVnd: number; taxAmountVnd: number; source: string; confidence: number | null; }
export interface ExpensePaymentFact { method: PaymentMethod; confirmationStatus: "unconfirmed" | "confirmed" | "rejected"; confirmedBy: string | null; confirmedAt: string | null; evidenceDocumentId: string | null; }
export interface ExpenseDocument { id: string; documentNumber: string | null; mimeType: string | null; byteSize: number | null; contentHash: string; status: string; }
export interface ExpenseDuplicateFinding {
  id: string; candidateExpenseId: string; signals: Record<string, unknown>; status: "open" | "dismissed" | "confirmed"; createdAt: string;
  candidate: { expenseNumber: string; grandTotalVnd: number; expenseDate: string; payeeName: string | null };
}
export interface ExpenseAccountingEvent { id: string; eventType: string; amountVnd: number; reviewStatus: string; createdAt: string; }
export interface ExpenseDetail {
  expense: ExpenseHeader; items: ExpenseItemRow[]; paymentFact: ExpensePaymentFact | null;
  document: ExpenseDocument | null; duplicateFindings: ExpenseDuplicateFinding[]; accountingEvents: ExpenseAccountingEvent[];
}
export interface CreateExpenseItemInput { description: string; quantity: number; unitCostVnd: number; taxAmountVnd?: number; source?: string; confidence?: number | null; }
export interface CreateExpenseInput {
  expenseDate?: string; payeeName?: string | null; categoryId?: string | null; amountVnd?: number; headerTaxVnd?: number;
  items?: CreateExpenseItemInput[]; paymentMethod?: PaymentMethod; paymentConfirmed?: boolean;
  documentId?: string | null; sourceType?: string; sourceId?: string | null;
}
export interface PostExpenseInput {
  expectedVersion?: number;
  paymentFact?: { method: PaymentMethod; confirmationStatus: "unconfirmed" | "confirmed" };
  duplicateReview?: { status: "NOT_DUPLICATE"; reason?: string };
}
export interface PostExpenseResult {
  expenseId: string; expenseNumber: string; status: string; grandTotalVnd: number;
  accountingEventId: string | null; duplicates: number; replayed?: boolean; alreadyPosted?: boolean;
}
export interface AiExpenseDraft {
  payee: string | null; expenseDate: string | null; documentNumber: string | null;
  lines: { description: string; quantity: number; unitCostVnd: number; source: string }[];
  totalVnd: number | null; taxVnd: number | null; categoryCandidates: string[]; warnings: string[];
}
export interface AiExpensePreviewResult { draft: AiExpenseDraft; documentId: string | null; contentHash: string | null; model: string; }
// ── Functional 08 documents ──────────────────────────────────────────────────
export type DocType = "purchase_invoice" | "goods_receipt" | "expense" | "sales_invoice" | "other";
export type DocStatus = "uploading" | "processing" | "review" | "ready" | "quarantined" | "archived" | "purged";
export type DocLinkedFilter = "all" | "linked" | "unlinked";
export interface DocLink {
  linkId: string | null; targetType: string; targetId: string; targetLabel: string;
  linkType: "primary" | "supporting" | "other"; number: string | null; route: string | null;
  source: "manual" | "auto"; removable: boolean; missing: boolean; createdAt?: string;
}
export interface DocSummary {
  id: string; status: DocStatus; documentType: DocType | null; documentTypeLabel: string | null;
  documentNumber: string | null; mimeType: string | null; byteSize: number | null; sha256: string | null;
  capturedAt: string; finalizedAt: string | null; retainUntil: string | null; legalHold: boolean;
  retentionStatus: string | null; rowVersion: number; createdBy: string | null;
  linked?: boolean; linkCount?: number; primaryLink?: DocLink | null; thumbUrl?: string | null;
}
export interface DocListParams {
  search?: string; type?: DocType; linked?: DocLinkedFilter; month?: string;
  includeArchived?: boolean; limit?: number; offset?: number;
}
export interface DocListResult {
  documents: DocSummary[]; hasMore: boolean; nextOffset: number | null;
  summary: { total: number; linked: number; unlinked: number };
}
export interface DocAccessEntry { action: string; purpose: string | null; createdAt: string; actorName: string | null; }
export interface DocDetailResult {
  document: DocSummary; links: DocLink[];
  pages: { pageNo: number; width: number | null; height: number | null }[];
  access: DocAccessEntry[];
}
export interface DocContent { url: string; action: "preview" | "download"; expiresIn: number; }
export interface DocUploadInput { fileBase64: string; mimeType: string; documentType?: DocType | null; documentNumber?: string; force?: boolean; }
export interface DocUploadResult { document: DocSummary; duplicateOverridden: boolean; replayed: boolean; }
export interface DocLinkCandidate { targetId: string; number: string | null; createdAt: string; route: string | null; }

// ── Functional 11 cashbook (sổ thu–chi) ──────────────────────────────────────
export type CashbookPeriod = "today" | "week" | "month" | "custom";
export type CashbookDirection = "in" | "out";
export type CashbookMethod = "cash" | "transfer" | "other" | "unknown";
export interface CashbookSource { sourceType: string; sourceId: string; label: string; route: string | null; sourceEventType?: string; sourceVersion?: number; }
export interface CashbookTypeTotal { direction: CashbookDirection; entryType: string; label: string; count: number; total: number; }
export interface CashbookCoverage { expected: number; processed: number; review: number; failed: number; pct: number; complete: boolean; }
export interface CashbookSummary {
  period: CashbookPeriod; from: string; to: string; timezone: string; asOf: string;
  totalIn: number; totalOut: number; difference: number;
  byType: CashbookTypeTotal[]; coverage: CashbookCoverage; reviewCount: number; ruleVersion: string;
}
export interface CashbookEntryRow {
  id: string; direction: CashbookDirection; entryType: string; entryLabel: string;
  amountVnd: number; occurredAt: string; paymentMethod: CashbookMethod; status: string;
  reversed: boolean; reversesEntryId: string | null; source: CashbookSource | null;
}
export interface CashbookEntriesResult { entries: CashbookEntryRow[]; hasMore: boolean; nextCursor: string | null; }
export interface CashbookEntriesQuery { direction?: string; entryType?: string; method?: string; status?: string; from?: string; to?: string; cursor?: string; limit?: number; }
export interface CashbookEntryDetail {
  entry: { id: string; direction: CashbookDirection; entryType: string; entryLabel: string; amountVnd: number; occurredAt: string; paymentMethod: CashbookMethod; status: string; ruleVersion: string; createdAt: string; };
  sources: CashbookSource[];
  reversed: boolean; reversalEntryId: string | null; reversesEntryId: string | null; reversalReason: string | null;
  canReverse: boolean; timeline: { state: string; at: string }[];
}
export interface CashbookDraftFields { direction?: CashbookDirection; entryType?: string; amountVnd?: number; occurredAt?: string; paymentMethod?: CashbookMethod; note?: string | null; }
export interface CashbookReviewDraft {
  sourceType: string | null; sourceId: string | null; sourceLabel: string | null; route?: string | null;
  direction: CashbookDirection | null; entryType: string | null; amountVnd: number | null;
  occurredAt: string | null; paymentMethod: CashbookMethod; note: string | null;
}
export interface CashbookReviewItem {
  id: string; eventId: string; status: string; rowVersion: number;
  reasonCodes: string[]; reasons: { code: string; label: string }[]; ready: boolean;
  draft: CashbookReviewDraft; createdAt: string;
}
export interface CashbookReviewPreview {
  reviewItemId: string; expectedRowVersion: number;
  preview: { direction: CashbookDirection; entryType: string; entryLabel: string; amountVnd: number; occurredAt: string; paymentMethod: CashbookMethod; ruleVersion: string; };
  impact: { direction: CashbookDirection; amountVnd: number };
}

// ── Functional 12 reconciliation ─────────────────────────────────────────────
export type ReconImpact = "low" | "medium" | "high";
export type ReconFamily = "missing" | "duplicate" | "amount_mismatch" | "state_mismatch" | "orphan";
export type ReconIssueStatus = "detected" | "in_review" | "action_pending" | "resolved" | "dismissed" | "failed";
export interface ReconDeepLink { kind: string; route: string; }
export interface ReconIssue {
  id: string; ruleId: string; ruleVersion?: string; family: ReconFamily; impact: ReconImpact;
  status: ReconIssueStatus; rowVersion: number; detectedAt: string; resolvedAt: string | null; runId: string | null;
  title: string; summary: string | null; command: string | null; actionHint: string | null; deepLink: ReconDeepLink | null;
}
export interface ReconEvidence {
  id: string; sourceType: string; sourceId: string; sourceVersion: number;
  facts: Record<string, unknown>; asOf: string; contentHash: string; maskPolicy: string; createdAt: string;
}
export interface ReconAttempt {
  id: string; actionType: string; intentId: string; status: string;
  ownerOperationId: string | null; resultRef: string | null; reason: Record<string, unknown>; actorId: string; createdAt: string;
}
export interface ReconLive { status: "unknown" | "cleared" | "still_mismatched"; facts: Record<string, unknown> | null; changed: boolean; }
export interface ReconAction { type: string; label: string; hint?: string; kind?: string; }
export interface ReconIssueDetail {
  issue: ReconIssue; ruleExplain: string | null; evidence: ReconEvidence[]; attempts: ReconAttempt[]; live: ReconLive; actions: ReconAction[];
}
export interface ReconCounters {
  ruleSetVersion?: string; rulesTotal: number; rulesOk: number; rulesFailed: number;
  checked: number; newIssues: number; matchedIssues: number; resolved: number;
  byFamily: Record<string, number>; byImpact: Record<string, number>; errors: { ruleId: string; message: string }[];
}
export interface ReconRun {
  id: string; scope: unknown; asOf: string; ruleSetVersion: string; status: string;
  counters: ReconCounters; createdBy: string; createdAt: string;
}
export interface ReconSummary {
  active: { total: number; byFamily: Record<string, number>; byImpact: Record<string, number> };
  resolvedTotal: number;
  lastRun: { id: string; asOf: string; status: string; counters: ReconCounters; createdAt: string } | null;
}

// ── Functional 15 sổ kế toán & dữ liệu thuế ───────────────────────────────────
export type TaxPeriodStatus = "open" | "review" | "locked" | "attention";
export interface TaxCoverage {
  expected: number; processed: number; missing: number; failed: number; pct: number; complete: boolean;
  bySource: Record<string, { expected: number; processed: number }>;
}
export interface TaxBookRow { code: string; name: string; short: string; legalRef: string; order: number; count: number; total: number; grossIn: number; grossOut: number; }
export interface TaxPeriodState { id: string; key: string; kind: string; label: string; start: string; end: string; timezone: string; status: TaxPeriodStatus; rowVersion: number; currentSnapshotId: string | null; currentVersionNo: number | null; }
export interface TaxOverview {
  period: TaxPeriodState; catalog: { code: string; ruleVersion: string };
  coverage: TaxCoverage; books: TaxBookRow[]; revenueVnd: number; lateCount: number;
  canLock: boolean; ruleVersion: string; asOf: string;
}
export interface TaxCatalog { id: string; code: string; status: string; scopeCode: string; ruleVersion: string; effectiveFrom: string; effectiveTo: string; legalBasis: { disclaimer?: string; sources: { code: string; title: string; url?: string; note?: string }[] }; contentHash: string; publishedAt: string | null; }
export interface TaxBookLine { id: string; recordType: string; businessDate: string; amountVnd: number; dimensions: Record<string, unknown>; status: string; ruleVersion: string; description: string; source: { sourceType: string; sourceId: string; label: string; route: string | null } | null; }
export interface TaxBookLedger { book: { code: string; name: string; short: string; legalRef: string }; period: { key: string; label: string; start: string; end: string; timezone: string }; lines: TaxBookLine[]; total: number; count: number; ruleVersion: string; }
export interface TaxRecordDetail { record: { id: string; recordType: string; bookCode: string; bookName: string; bookShort: string; businessDate: string; amountVnd: number; dimensions: Record<string, unknown>; status: string; ruleVersion: string; contentHash: string; description: string; createdAt: string }; sources: { relation: string; sourceType: string; sourceId: string; label: string; route: string | null; occurredAt: string | null; status: string }[]; replaces: { id: string; amountVnd: number } | null; }
export interface TaxLockPreview {
  periodId: string; period: { key: string; label: string; start: string; end: string; timezone: string };
  asOf: string; previewHash: string; versionNo: number; isRestatement: boolean;
  bookTotals: { code: string; total: number; count: number }[]; revenueVnd: number; recordCount: number;
  coverage: TaxCoverage; blocking: { code: string; severity: string; message: string; count?: number }[];
  warnings: { code: string; severity: string; message: string }[]; canLock: boolean; ruleVersion: string; catalogCode: string;
}
export interface TaxSnapshot { id: string; periodId: string; versionNo: number; periodStart: string; periodEnd: string; timezone: string; asOf: string | null; watermark: unknown; coverage: TaxCoverage; contentHash: string; ruleVersion: string; catalogCode: string; lockedBy: string; lockedAt: string; previousSnapshotId: string | null; isCurrent: boolean; books: { code: string; total: number; count: number }[]; }
export interface TaxSnapshotList { period: TaxPeriodState; snapshots: { id: string; versionNo: number; asOf: string | null; recordCount: number | null; coverage: TaxCoverage; contentHash: string; ruleVersion: string; lockedBy: string; lockedAt: string; previousSnapshotId: string | null; isCurrent: boolean }[]; }
export interface TaxPackageLine { code: string; sequenceNo: number; label: string; amountVnd: number | null; legalNote: string | null; sourceIndex: Record<string, unknown>; }
export interface TaxPackageResult {
  package: { id: string; snapshotId: string; definitionCode: string; definitionVersion: string; status: string; coverage: TaxCoverage; totals: Record<string, number> & { channels?: Record<string, number> }; contentHash: string; catalogCode: string; ruleVersion: string; createdAt: string };
  lines: TaxPackageLine[]; disclaimer: string;
}
export type TaxExportScope = { kind: "all_books" } | { kind: "book"; bookCode: string } | { kind: "package" };
export interface TaxExport { id: string; format: string; formatVersion: string; objectKey: string; contentHash: string; createdAt: string; }
