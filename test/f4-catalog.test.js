// Pure-logic unit tests for the Functional 04 catalog (no DB). Runs under
// `node --test` alongside the ported PayOS tests. Covers: search-name/SKU
// normalisation (must equal Postgres unaccent(lower())), the Postgres→domain
// error mapping for catalog uniqueness/constraints, and product-input validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchName, normalizeSku, normalizeBarcode } from "../server/f3/text.js";
import { mapPgError, DomainError } from "../server/f3/errors.js";
import { validateProductInput } from "../server/f3/products.js";

test("normalizeSearchName strips Vietnamese diacritics + đ, lowercases, collapses ws", () => {
  assert.equal(normalizeSearchName("Nước Suối Đá"), "nuoc suoi da");
  assert.equal(normalizeSearchName("Cà PHÊ  sữa"), "ca phe sua");
  assert.equal(normalizeSearchName("  Bánh   mì  "), "banh mi");
  assert.equal(normalizeSearchName("Trà đào cam sả"), "tra dao cam sa");
  assert.equal(normalizeSearchName("ĐƯỜNG"), "duong");
  assert.equal(normalizeSearchName(null), "");
  assert.equal(normalizeSearchName(undefined), "");
});

test("normalizeSku uppercases, trims, empty → null", () => {
  assert.equal(normalizeSku("ns500"), "NS500");
  assert.equal(normalizeSku("  abc 12 "), "ABC 12");
  assert.equal(normalizeSku(""), null);
  assert.equal(normalizeSku("   "), null);
  assert.equal(normalizeSku(null), null);
});

test("normalizeBarcode trims, empty → null (case preserved)", () => {
  assert.equal(normalizeBarcode(" 8938 "), "8938");
  assert.equal(normalizeBarcode(""), null);
  assert.equal(normalizeBarcode(null), null);
});

test("mapPgError maps catalog uniqueness to domain codes", () => {
  const sku = mapPgError({ code: "23505", message: 'duplicate key value violates unique constraint "products_merchant_id_sku_key"' });
  assert.ok(sku instanceof DomainError);
  assert.equal(sku.code, "PRODUCT_SKU_CONFLICT");
  assert.equal(sku.status, 409);

  const barcode = mapPgError({ code: "23505", message: 'duplicate key value violates unique constraint "products_barcode_unique"' });
  assert.equal(barcode.code, "PRODUCT_BARCODE_CONFLICT");

  const cat = mapPgError({ code: "23505", message: 'duplicate key value violates unique constraint "product_categories_merchant_id_name_key"' });
  assert.equal(cat.code, "CATEGORY_NAME_CONFLICT");
});

test("mapPgError maps the service-no-inventory CHECK to 422", () => {
  const e = mapPgError({ code: "23514", message: 'new row violates check constraint "products_service_no_inventory"' });
  assert.equal(e.code, "SERVICE_NO_INVENTORY");
  assert.equal(e.status, 422);
});

test("validateProductInput normalises + rejects bad values", () => {
  const ok = validateProductInput({ name: "  Nước  suối ", productType: "goods", salePrice: "10000", unitCode: "chai" });
  assert.equal(ok.name, "Nước suối");
  assert.equal(ok.productType, "goods");
  assert.equal(ok.salePrice, 10000);
  assert.equal(ok.unitCode, "chai");

  assert.throws(() => validateProductInput({ name: "", productType: "goods", salePrice: 1, unitCode: "chai" }), /1–120/);
  assert.throws(() => validateProductInput({ name: "x", productType: "goods", salePrice: -5, unitCode: "chai" }), /0đ/);
  assert.throws(() => validateProductInput({ name: "x", productType: "banana", salePrice: 1, unitCode: "chai" }), /Loại/);
});

test("validateProductInput (partial) only touches provided fields", () => {
  const out = validateProductInput({ salePrice: 5000 }, { partial: true });
  assert.deepEqual(Object.keys(out), ["salePrice"]);
  assert.equal(out.salePrice, 5000);
  const sku = validateProductInput({ sku: "ns500" }, { partial: true });
  assert.equal(sku.sku, "NS500");
});
