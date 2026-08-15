// Functional 04 pure client helpers: the same unaccented search-name normalisation
// the server uses (so local instant-filter matches server search), plus SKU
// canonicalisation, unit labels and form validation. Kept pure + dependency-free
// so it is unit-tested (src/lib/catalog.test.ts) and can't drift from the server's
// server/f3/text.js implementation.

/** Lowercase + strip Vietnamese diacritics + collapse whitespace (≡ server). */
export function normalizeSearchName(input: string | null | undefined): string {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

/** Canonical stored SKU form: uppercased + trimmed; empty → null. */
export function normalizeSku(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = String(input).trim().toUpperCase().replace(/\s+/g, " ");
  return s.length ? s : null;
}

/** Does `query` match a product locally? Mirrors the server's OR-search. */
export function matchesQuery(
  p: { name: string; searchName?: string | null; sku?: string | null; barcode?: string | null },
  query: string,
): boolean {
  const q = query.trim();
  if (!q) return true;
  const nq = normalizeSearchName(q);
  const sn = p.searchName ?? normalizeSearchName(p.name);
  return (
    sn.includes(nq) ||
    normalizeSearchName(p.name).includes(nq) ||
    (p.sku ?? "").toUpperCase() === q.toUpperCase() ||
    (p.barcode ?? "") === q
  );
}

export type ProductType = "goods" | "service";
export type ProductStatus = "active" | "inactive" | "archived";

export const UNIT_OPTIONS: { value: string; label: string }[] = [
  { value: "item", label: "Cái" }, { value: "chai", label: "Chai" }, { value: "goi", label: "Gói" },
  { value: "hop", label: "Hộp" }, { value: "lon", label: "Lon" }, { value: "thung", label: "Thùng" },
  { value: "kg", label: "Kg" }, { value: "lit", label: "Lít" }, { value: "phan", label: "Phần" },
  { value: "lan", label: "Lần" }, { value: "bo", label: "Bộ" },
];

export function unitLabel(code: string | null | undefined): string {
  if (!code) return "";
  return UNIT_OPTIONS.find((u) => u.value === code)?.label ?? code;
}

export const STATUS_LABEL: Record<ProductStatus, string> = {
  active: "Đang bán",
  inactive: "Tạm ngừng",
  archived: "Đã lưu trữ",
};

/** Draft the create/edit form edits before it is sent to the server. */
export interface ProductDraft {
  name: string;
  productType: ProductType;
  categoryId: string | null;
  unitCode: string;
  price: string;          // digits-only string
  sku: string;
  barcode: string;
  trackInventory: boolean;
  openingQty: string;
  lowStockThreshold: string;
  allowDiscount: boolean;
  negativeStockPolicy: "block" | "allow_owner";
}

export function emptyDraft(productType: ProductType = "goods"): ProductDraft {
  return {
    name: "", productType, categoryId: null, unitCode: productType === "service" ? "lan" : "item",
    price: "", sku: "", barcode: "", trackInventory: productType === "goods",
    openingQty: "", lowStockThreshold: "", allowDiscount: true, negativeStockPolicy: "block",
  };
}

export interface DraftErrors { name?: string; price?: string; unitCode?: string; }

/** Field-level validation matching the server rules (spec 5 PRD_001/002). */
export function validateDraft(d: ProductDraft): DraftErrors {
  const errors: DraftErrors = {};
  const name = d.name.trim();
  if (name.length < 1) errors.name = "Nhập tên hàng hóa hoặc dịch vụ.";
  else if (name.length > 120) errors.name = "Tên tối đa 120 ký tự.";
  if (d.price === "" || !/^\d+$/.test(d.price)) errors.price = "Giá phải là số từ 0đ trở lên.";
  if (d.productType === "goods" && !d.unitCode.trim()) errors.unitCode = "Chọn đơn vị.";
  return errors;
}

export function isDraftValid(d: ProductDraft): boolean {
  return Object.keys(validateDraft(d)).length === 0;
}

/** Map a validated draft to the POST /products body (server re-validates). */
export function draftToCreateBody(d: ProductDraft, draftId: string): Record<string, unknown> {
  const track = d.productType === "goods" && d.trackInventory;
  return {
    draft_id: draftId,
    name: d.name.trim(),
    productType: d.productType,
    categoryId: d.categoryId,
    unitCode: d.unitCode.trim() || "item",
    salePrice: Number(d.price || 0),
    sku: d.sku.trim() || null,
    barcode: d.barcode.trim() || null,
    trackInventory: track,
    negativeStockPolicy: d.negativeStockPolicy,
    lowStockThreshold: track && d.lowStockThreshold !== "" ? Number(d.lowStockThreshold) : null,
    allowDiscount: d.allowDiscount,
    openingQty: track && d.openingQty !== "" ? Number(d.openingQty) : 0,
  };
}
