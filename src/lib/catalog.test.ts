import { describe, it, expect } from "vitest";
import {
  normalizeSearchName, normalizeSku, matchesQuery, validateDraft, isDraftValid,
  draftToCreateBody, emptyDraft, unitLabel,
} from "./catalog";

describe("normalizeSearchName (client ≡ server)", () => {
  it("strips Vietnamese diacritics + đ, lowercases, collapses whitespace", () => {
    expect(normalizeSearchName("Nước Suối Đá")).toBe("nuoc suoi da");
    expect(normalizeSearchName("Cà PHÊ  sữa")).toBe("ca phe sua");
    expect(normalizeSearchName("  Bánh   mì  ")).toBe("banh mi");
    expect(normalizeSearchName("ĐƯỜNG")).toBe("duong");
    expect(normalizeSearchName(null)).toBe("");
  });
});

describe("normalizeSku", () => {
  it("uppercases + trims; empty → null", () => {
    expect(normalizeSku("ns500")).toBe("NS500");
    expect(normalizeSku("  ")).toBeNull();
    expect(normalizeSku(null)).toBeNull();
  });
});

describe("matchesQuery", () => {
  const p = { name: "Nước suối 500ml", searchName: "nuoc suoi 500ml", sku: "NS500", barcode: "8938500700123" };
  it("matches unaccented name substrings", () => {
    expect(matchesQuery(p, "nuoc")).toBe(true);
    expect(matchesQuery(p, "SUOI")).toBe(true);
    expect(matchesQuery(p, "suối")).toBe(true);
  });
  it("matches exact SKU (case-insensitive) and exact barcode", () => {
    expect(matchesQuery(p, "ns500")).toBe(true);
    expect(matchesQuery(p, "8938500700123")).toBe(true);
  });
  it("empty query matches everything; unrelated query does not", () => {
    expect(matchesQuery(p, "")).toBe(true);
    expect(matchesQuery(p, "bánh")).toBe(false);
  });
});

describe("validateDraft", () => {
  it("flags empty name and non-numeric price", () => {
    const d = emptyDraft("goods");
    const e = validateDraft(d);
    expect(e.name).toBeTruthy();
    expect(e.price).toBeTruthy();
    expect(isDraftValid(d)).toBe(false);
  });
  it("passes a complete goods draft", () => {
    const d = { ...emptyDraft("goods"), name: "Nước suối", price: "10000", unitCode: "chai" };
    expect(validateDraft(d)).toEqual({});
    expect(isDraftValid(d)).toBe(true);
  });
  it("rejects a >120 char name", () => {
    const d = { ...emptyDraft("goods"), name: "x".repeat(121), price: "0", unitCode: "chai" };
    expect(validateDraft(d).name).toBeTruthy();
  });
});

describe("draftToCreateBody", () => {
  it("maps a tracked goods draft with opening stock", () => {
    const d = { ...emptyDraft("goods"), name: " Nước suối ", price: "10000", unitCode: "chai", trackInventory: true, openingQty: "24", lowStockThreshold: "5", sku: "ns500" };
    const body = draftToCreateBody(d, "draft-1");
    expect(body).toMatchObject({
      draft_id: "draft-1", name: "Nước suối", productType: "goods", unitCode: "chai",
      salePrice: 10000, sku: "ns500", trackInventory: true, openingQty: 24, lowStockThreshold: 5,
    });
  });
  it("forces service to no inventory + zero opening", () => {
    const d = { ...emptyDraft("service"), name: "Giặt ủi", price: "20000", unitCode: "lan", trackInventory: true, openingQty: "9" };
    const body = draftToCreateBody(d, "draft-2");
    expect(body.trackInventory).toBe(false);
    expect(body.openingQty).toBe(0);
    expect(body.lowStockThreshold).toBeNull();
  });
});

describe("unitLabel", () => {
  it("maps known codes and falls back to the raw code", () => {
    expect(unitLabel("chai")).toBe("Chai");
    expect(unitLabel("lan")).toBe("Lần");
    expect(unitLabel("weird")).toBe("weird");
    expect(unitLabel(null)).toBe("");
  });
});
