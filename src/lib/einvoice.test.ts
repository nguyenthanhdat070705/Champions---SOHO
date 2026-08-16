// Functional 09 client helper tests (vitest, no DB) — mirror the server rules so the
// UI blocks/enables the same way the server will accept/reject.
import { describe, expect, it } from "vitest";
import {
  isValidTaxId, normalizeTaxId, isValidEmail, buyerBlockingReason, sellerReady,
  STATUS_META, STATUS_FILTERS,
} from "./einvoice";
import type { InvoiceBuyer, InvoiceSeller } from "./einvoice";

describe("tax id + email", () => {
  it("accepts 10/13-digit MST, rejects malformed", () => {
    expect(isValidTaxId("0101010101")).toBe(true);
    expect(isValidTaxId("0101010101-001")).toBe(true);
    expect(isValidTaxId("0101 010 101")).toBe(true);
    expect(isValidTaxId("123")).toBe(false);
    expect(normalizeTaxId("0101 010 101")).toBe("0101010101");
  });
  it("validates email", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
  });
});

describe("buyerBlockingReason", () => {
  const ind = (o: Partial<InvoiceBuyer> = {}): InvoiceBuyer => ({ kind: "individual", name: null, taxCode: null, address: null, email: null, ...o });
  const org = (o: Partial<InvoiceBuyer> = {}): InvoiceBuyer => ({ kind: "organization", name: null, taxCode: null, address: null, email: null, ...o });
  it("individual with nothing is allowed (khách lẻ)", () => {
    expect(buyerBlockingReason(ind())).toBeNull();
  });
  it("organization needs name + valid MST", () => {
    expect(buyerBlockingReason(org())).toMatch(/tên tổ chức/);
    expect(buyerBlockingReason(org({ name: "Cty" }))).toMatch(/mã số thuế/);
    expect(buyerBlockingReason(org({ name: "Cty", taxCode: "0101010101" }))).toBeNull();
  });
  it("individual with a bad MST or email is blocked", () => {
    expect(buyerBlockingReason(ind({ taxCode: "12" }))).toMatch(/thuế/);
    expect(buyerBlockingReason(ind({ email: "bad" }))).toMatch(/[Ee]mail/);
  });
});

describe("sellerReady", () => {
  const s = (o: Partial<InvoiceSeller>): InvoiceSeller => ({ legalName: null, taxCode: null, address: null, ...o });
  it("requires legal name + valid MST", () => {
    expect(sellerReady(s({ legalName: "A", taxCode: "0101010101" }))).toBe(true);
    expect(sellerReady(s({ legalName: "A" }))).toBe(false);
    expect(sellerReady(s({ legalName: "A", taxCode: "bad" }))).toBe(false);
    expect(sellerReady(null)).toBe(false);
  });
});

describe("status metadata is honest", () => {
  it("submitting is 'Đang xử lý', accepted is 'Đã phát hành' (never 'Đã gửi')", () => {
    expect(STATUS_META.submitting.label).toBe("Đang xử lý");
    expect(STATUS_META.accepted.label).toBe("Đã phát hành");
    for (const m of Object.values(STATUS_META)) expect(m.label).not.toBe("Đã gửi");
  });
  it("has a filter set", () => {
    expect(STATUS_FILTERS.some((f) => f.value === "accepted")).toBe(true);
  });
});
