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
};

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
