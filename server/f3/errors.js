// The Functional 03 error contract (spec 11.1). Domain errors carry a stable
// `code` the mobile UI switches on, and an HTTP status. Keep the codes and
// user-facing Vietnamese messages in sync with src/lib/api.ts on the client.

/** HTTP status for each domain error code (spec 11.1 + auth/validation). */
export const ERROR_STATUS = {
  // Validation / auth
  VALIDATION: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  PAYMENT_NOT_FOUND: 404,
  // Concurrency / pricing (spec 11.1)
  VERSION_CONFLICT: 409,
  PRICE_CHANGED: 409,
  INSUFFICIENT_STOCK: 409,
  PAYMENT_ALREADY_SUCCEEDED: 409,
  PAYMENT_PENDING: 409,
  IDEMPOTENCY_PAYLOAD_MISMATCH: 409,
  REFUND_EXCEEDS_AVAILABLE: 409,
  ORDER_NOT_PAYABLE: 409,
  // Discount / connection
  DISCOUNT_NOT_ALLOWED: 403,
  QR_CONNECTION_UNAVAILABLE: 400,
  INVALID_CASH_AMOUNT: 400,
  // Catalog (Functional 04, spec 5 / 10.1)
  PRODUCT_NOT_FOUND: 404,
  PRODUCT_SKU_CONFLICT: 409,
  PRODUCT_BARCODE_CONFLICT: 409,
  CATEGORY_NAME_CONFLICT: 409,
  SERVICE_NO_INVENTORY: 422,
  AI_PREVIEW_FAILED: 502,
  // Inventory (Functional 05, spec 5 / 10.1)
  INVENTORY_BALANCE_CHANGED: 409,
  INVENTORY_NOT_TRACKED: 422,
  REASON_REQUIRED: 400,
  MOVEMENT_NOT_FOUND: 404,
  MOVEMENT_NOT_REVERSIBLE: 422,
  MOVEMENT_ALREADY_REVERSED: 409,
  COUNT_NOT_FOUND: 404,
  COUNT_ALREADY_POSTED: 409,
  COUNT_INVALID_STATE: 409,
  // Receiving (Functional 06, spec 5 / 10.1)
  RECEIPT_NOT_FOUND: 404,
  RECEIPT_NO_LINES: 400,
  RECEIPT_INVALID_STATE: 409,
  RECEIPT_ALREADY_POSTED: 409,
  RECEIPT_DUPLICATE_PRODUCT: 409,
  RECEIPT_REVERSE_NEGATIVE: 409,
  RECEIPT_NOT_REVERSIBLE: 422,
  POSSIBLE_DUPLICATE_DOCUMENT: 409,
  DOCUMENT_NOT_FOUND: 404,
  SUPPLIER_NAME_CONFLICT: 409,
  AI_EXTRACT_FAILED: 502,
  STORAGE_UNAVAILABLE: 502,
  // Expenses (Functional 07, spec 5 / 10.1)
  EXPENSE_NOT_FOUND: 404,
  EXPENSE_CATEGORY_NOT_FOUND: 404,
  EXPENSE_NOT_EDITABLE: 409,
  EXPENSE_NOT_POSTED: 409,
  EXPENSE_ALREADY_REVERSED: 409,
  CATEGORY_REQUIRED: 400,
  AMOUNT_REQUIRED: 400,
  POSSIBLE_DUPLICATE_EXPENSE: 409,
  DUPLICATE_FINDING_NOT_FOUND: 404,
  // Documents (Functional 08, spec 5 / 10.1) — DOCUMENT_NOT_FOUND shared with F06 above
  DOCUMENT_MIME_UNSUPPORTED: 400,
  DOCUMENT_TOO_LARGE: 413,
  DOCUMENT_ALREADY_EXISTS: 409,
  DOCUMENT_QUARANTINED: 403,
  DOCUMENT_NOT_VIEWABLE: 409,
  DOCUMENT_VERSION_CHANGED: 409,
  LINK_TARGET_NOT_FOUND: 404,
  LINK_NOT_FOUND: 404,
  LEGAL_HOLD: 409,
  STORAGE_ERROR: 502,
  // E-invoice (Functional 09, spec 5 / 10.1)
  ORDER_NOT_ELIGIBLE: 409,
  INVOICE_NOT_FOUND: 404,
  INVOICE_EXISTS: 409,
  INVOICE_NOT_EDITABLE: 409,
  INVOICE_NOT_VALIDATED: 409,
  INVOICE_VALIDATION_FAILED: 422,
  INVOICE_NOT_ACCEPTED: 409,
  ACKNOWLEDGEMENT_REQUIRED: 400,
  RELATION_NOT_ALLOWED: 409,
  PROVIDER_NOT_CONFIGURED: 400,
  WEBHOOK_INVALID: 400,
  ARTIFACT_NOT_FOUND: 404,
  // Infra
  OFFLINE: 503,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
};

/** Default Vietnamese user-facing message per code (spec 11.1). */
export const ERROR_MESSAGE = {
  VALIDATION: "Dữ liệu không hợp lệ.",
  IDEMPOTENCY_KEY_REQUIRED: "Thiếu Idempotency-Key.",
  UNAUTHORIZED: "Bạn cần đăng nhập.",
  FORBIDDEN: "Bạn không có quyền thực hiện thao tác này.",
  NOT_FOUND: "Không tìm thấy.",
  ORDER_NOT_FOUND: "Không tìm thấy bill.",
  PAYMENT_NOT_FOUND: "Không tìm thấy giao dịch.",
  VERSION_CONFLICT: "Giỏ đã thay đổi ở thiết bị khác. Vui lòng tải lại bill.",
  PRICE_CHANGED: "Giá hoặc khuyến mãi đã thay đổi. Vui lòng kiểm tra lại.",
  INSUFFICIENT_STOCK: "Không đủ tồn kho.",
  PAYMENT_ALREADY_SUCCEEDED: "Bill đã được thanh toán.",
  PAYMENT_PENDING: "Đang có mã QR còn hiệu lực cho bill này.",
  IDEMPOTENCY_PAYLOAD_MISMATCH: "Yêu cầu trùng khóa nhưng khác nội dung.",
  REFUND_EXCEEDS_AVAILABLE: "Số tiền hoàn vượt quá số còn có thể hoàn.",
  ORDER_NOT_PAYABLE: "Bill không ở trạng thái có thể thu tiền.",
  DISCOUNT_NOT_ALLOWED: "Giảm giá vượt quyền hoặc vượt trần cho phép.",
  QR_CONNECTION_UNAVAILABLE: "Kết nối QR chưa sẵn sàng. Hãy chọn tiền mặt hoặc kiểm tra Cài đặt.",
  INVALID_CASH_AMOUNT: "Số tiền khách đưa chưa hợp lệ.",
  PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm.",
  PRODUCT_SKU_CONFLICT: "SKU này đang dùng cho sản phẩm khác.",
  PRODUCT_BARCODE_CONFLICT: "Mã này đã thuộc một sản phẩm khác.",
  CATEGORY_NAME_CONFLICT: "Tên nhóm hàng đã tồn tại.",
  SERVICE_NO_INVENTORY: "Dịch vụ không theo dõi tồn kho.",
  AI_PREVIEW_FAILED: "Chưa đọc được lúc này, bạn có thể nhập tay.",
  INVENTORY_BALANCE_CHANGED: "Số tồn vừa thay đổi. Vui lòng kiểm tra lại trước khi xác nhận.",
  INVENTORY_NOT_TRACKED: "Mặt hàng này không theo dõi tồn kho.",
  REASON_REQUIRED: "Vui lòng chọn lý do điều chỉnh.",
  MOVEMENT_NOT_FOUND: "Không tìm thấy bút toán tồn kho.",
  MOVEMENT_NOT_REVERSIBLE: "Chỉ có thể đảo bút toán điều chỉnh tay hoặc kiểm kê.",
  MOVEMENT_ALREADY_REVERSED: "Bút toán này đã được đảo trước đó.",
  COUNT_NOT_FOUND: "Không tìm thấy phiên kiểm kho.",
  COUNT_ALREADY_POSTED: "Phiên kiểm kho đã hoàn tất.",
  COUNT_INVALID_STATE: "Phiên kiểm kho không ở trạng thái phù hợp cho thao tác này.",
  RECEIPT_NOT_FOUND: "Không tìm thấy phiếu nhập.",
  RECEIPT_NO_LINES: "Thêm ít nhất một mặt hàng để tiếp tục.",
  RECEIPT_INVALID_STATE: "Phiếu nhập không ở trạng thái phù hợp cho thao tác này.",
  RECEIPT_ALREADY_POSTED: "Phiếu này đã được ghi nhận.",
  RECEIPT_DUPLICATE_PRODUCT: "Một mặt hàng chỉ nên có một dòng trong phiếu.",
  RECEIPT_REVERSE_NEGATIVE: "Không thể đảo phiếu vì hàng đã được bán hoặc sử dụng.",
  RECEIPT_NOT_REVERSIBLE: "Chỉ phiếu đã ghi nhận mới có thể đảo.",
  POSSIBLE_DUPLICATE_DOCUMENT: "Chứng từ này có thể đã được nhập trước đó.",
  DOCUMENT_NOT_FOUND: "Không tìm thấy chứng từ.",
  SUPPLIER_NAME_CONFLICT: "Tên nhà cung cấp đã tồn tại.",
  AI_EXTRACT_FAILED: "Chưa đọc được chứng từ, bạn có thể nhập tay.",
  STORAGE_UNAVAILABLE: "Chưa lưu được ảnh chứng từ. Vui lòng thử lại.",
  EXPENSE_NOT_FOUND: "Không tìm thấy khoản chi.",
  EXPENSE_CATEGORY_NOT_FOUND: "Không tìm thấy nhóm chi.",
  EXPENSE_NOT_EDITABLE: "Khoản chi đã ghi nhận, không thể sửa. Hãy dùng đảo bút toán.",
  EXPENSE_NOT_POSTED: "Chỉ có thể đảo khoản chi đã ghi nhận.",
  EXPENSE_ALREADY_REVERSED: "Khoản chi này đã được đảo trước đó.",
  CATEGORY_REQUIRED: "Chọn nhóm chi trước khi ghi.",
  AMOUNT_REQUIRED: "Nhập tổng chi lớn hơn 0.",
  POSSIBLE_DUPLICATE_EXPENSE: "Khoản chi này có thể đã được ghi trước đó.",
  DUPLICATE_FINDING_NOT_FOUND: "Không tìm thấy cảnh báo trùng.",
  DOCUMENT_MIME_UNSUPPORTED: "Chỉ dùng ảnh JPG, PNG hoặc WEBP.",
  DOCUMENT_TOO_LARGE: "Tệp quá lớn. Giảm kích thước rồi thử lại (tối đa 10 MB).",
  DOCUMENT_ALREADY_EXISTS: "Chứng từ này đã có trong Hộp chứng từ.",
  DOCUMENT_QUARANTINED: "Tệp đã bị cách ly, không thể xem.",
  DOCUMENT_NOT_VIEWABLE: "Chứng từ không ở trạng thái có thể xem.",
  DOCUMENT_VERSION_CHANGED: "Chứng từ vừa thay đổi. Vui lòng tải lại.",
  LINK_TARGET_NOT_FOUND: "Nghiệp vụ đã thay đổi; hãy tìm lại.",
  LINK_NOT_FOUND: "Không tìm thấy liên kết.",
  LEGAL_HOLD: "Chứng từ đang được giữ và không thể xóa.",
  STORAGE_ERROR: "Không lưu được tệp. Vui lòng thử lại.",
  ORDER_NOT_ELIGIBLE: "Bill chưa đủ điều kiện xuất hóa đơn.",
  INVOICE_NOT_FOUND: "Không tìm thấy hóa đơn.",
  INVOICE_EXISTS: "Bill đã được xuất hóa đơn.",
  INVOICE_NOT_EDITABLE: "Hóa đơn không còn ở trạng thái được sửa.",
  INVOICE_NOT_VALIDATED: "Hóa đơn cần được kiểm tra hợp lệ trước khi phát hành.",
  INVOICE_VALIDATION_FAILED: "Hóa đơn chưa hợp lệ. Vui lòng kiểm tra lại thông tin.",
  INVOICE_NOT_ACCEPTED: "Chỉ hóa đơn đã được chấp nhận mới thực hiện được thao tác này.",
  ACKNOWLEDGEMENT_REQUIRED: "Vui lòng xác nhận đã kiểm tra thông tin trước khi phát hành.",
  RELATION_NOT_ALLOWED: "Không thể tạo hóa đơn điều chỉnh/thay thế ở trạng thái này.",
  PROVIDER_NOT_CONFIGURED: "Nhà cung cấp hóa đơn chưa sẵn sàng.",
  WEBHOOK_INVALID: "Sự kiện nhà cung cấp không hợp lệ.",
  ARTIFACT_NOT_FOUND: "Không tìm thấy tệp hóa đơn.",
  OFFLINE: "Không kết nối được máy chủ.",
  PROVIDER_ERROR: "Đối tác thanh toán tạm thời lỗi. Vui lòng thử lại.",
  INTERNAL: "Có lỗi xảy ra. Vui lòng thử lại.",
};

export class DomainError extends Error {
  /**
   * @param {string} code    stable error code (a key of ERROR_STATUS)
   * @param {string} [message] override user-facing message
   * @param {object} [details] extra structured data for the UI (e.g. price diff)
   */
  constructor(code, message, details) {
    super(message || ERROR_MESSAGE[code] || code);
    this.name = "DomainError";
    this.code = code;
    this.status = ERROR_STATUS[code] || 400;
    if (details) this.details = details;
  }
}

/** Convenience thrower. */
export function fail(code, message, details) {
  throw new DomainError(code, message, details);
}

/**
 * Map a raw Postgres error to a DomainError where a constraint stands in for a
 * business rule, so the UI still gets a clean code instead of a 500.
 */
export function mapPgError(err) {
  if (err instanceof DomainError) return err;
  const msg = String(err?.message || "");
  // A raised exception message from a function/trigger, e.g. 'FORBIDDEN'.
  if (err?.code === "P0001") {
    const raised = msg.replace(/^.*?:\s*/, "").trim();
    if (ERROR_STATUS[raised]) return new DomainError(raised);
  }
  // Unique violation on the one-successful-payment guard → already paid.
  if (err?.code === "23505") {
    if (/one_successful_payment_per_order/.test(msg)) {
      return new DomainError("PAYMENT_ALREADY_SUCCEEDED");
    }
    if (/idempotency/.test(msg)) {
      return new DomainError("IDEMPOTENCY_PAYLOAD_MISMATCH");
    }
    // Catalog uniqueness (spec 4.2 / 5). The explicit paths in products.js add
    // existing_product_id; this is the router-level safety net.
    if (/products_merchant_id_sku_key|products.*sku/.test(msg)) {
      return new DomainError("PRODUCT_SKU_CONFLICT", undefined, { field: "sku", action: "OPEN_EXISTING_PRODUCT" });
    }
    if (/products_barcode_unique|products.*barcode/.test(msg)) {
      return new DomainError("PRODUCT_BARCODE_CONFLICT", undefined, { field: "barcode", action: "OPEN_EXISTING_PRODUCT" });
    }
    if (/product_categories_merchant_id_name_key/.test(msg)) {
      return new DomainError("CATEGORY_NAME_CONFLICT", undefined, { field: "name" });
    }
    if (/suppliers_merchant_id_name_key/.test(msg)) {
      return new DomainError("SUPPLIER_NAME_CONFLICT", undefined, { field: "name" });
    }
  }
  // The service-can't-track-inventory guard is a 422 (spec 12.3 PRD-02).
  if (err?.code === "23514" && /products_service_no_inventory/.test(msg)) {
    return new DomainError("SERVICE_NO_INVENTORY", undefined, { field: "trackInventory" });
  }
  // Not-null / check violations surface as validation problems, not 500s.
  if (err?.code === "23514" || err?.code === "23502") {
    return new DomainError("VALIDATION", `Ràng buộc dữ liệu: ${msg}`);
  }
  return err;
}
