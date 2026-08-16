// Functional 09 pure-logic unit tests (no DB) — seller/buyer/line validation
// (INV-04 buyer MST, seller readiness, INV-05 tax mapping). Part of `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidTaxId, normalizeTaxId, validateSeller, validateBuyer, validateLines, validateInvoice, MAX_LINES,
} from "../server/f9/validation.js";

test("isValidTaxId accepts 10-digit and 13-digit branch MST, rejects the rest", () => {
  assert.equal(isValidTaxId("0101010101"), true);
  assert.equal(isValidTaxId("0101010101-001"), true);
  assert.equal(isValidTaxId("0101 010 101"), true); // spaces tolerated
  assert.equal(isValidTaxId("123"), false);
  assert.equal(isValidTaxId("010101010A"), false);
  assert.equal(isValidTaxId("0101010101-01"), false);
  assert.equal(normalizeTaxId("0101 010 101"), "0101010101");
});

test("seller readiness blocks a missing name or MST (spec 3.3)", () => {
  assert.equal(validateSeller({ legalName: "Cửa hàng A", taxCode: "0101010101" }).length, 0);
  const errs = validateSeller({ legalName: "", taxCode: "" });
  assert.ok(errs.some((e) => e.code === "SELLER_NAME_MISSING"));
  assert.ok(errs.some((e) => e.code === "SELLER_TAX_ID_MISSING"));
});

test("organization buyer requires name + valid MST (INV-04)", () => {
  assert.deepEqual(validateBuyer({ kind: "organization", name: "Cty B", taxCode: "0101010101" }), []);
  const errs = validateBuyer({ kind: "organization", name: "", taxCode: "999" });
  assert.ok(errs.some((e) => e.code === "BUYER_NAME_REQUIRED"));
  assert.ok(errs.some((e) => e.code === "BUYER_TAX_ID_INVALID"));
});

test("individual buyer may omit name and MST (khách lẻ)", () => {
  assert.deepEqual(validateBuyer({ kind: "individual" }), []);
  assert.deepEqual(validateBuyer({ kind: "individual", name: "Chị Lan" }), []);
});

test("individual buyer with a malformed MST is still rejected", () => {
  const errs = validateBuyer({ kind: "individual", taxCode: "12" });
  assert.ok(errs.some((e) => e.code === "BUYER_TAX_ID_INVALID"));
});

test("buyer email, if given, must be valid (delivery channel only)", () => {
  assert.equal(validateBuyer({ kind: "individual", email: "a@b.co" }).length, 0);
  assert.ok(validateBuyer({ kind: "individual", email: "not-an-email" }).some((e) => e.code === "BUYER_EMAIL_INVALID"));
});

test("every line must have an allowlisted tax code (INV-05)", () => {
  const good = [{ description: "X", taxCode: "VAT8", quantity: 1, lineTotalVnd: 1000 }];
  assert.equal(validateLines(good).length, 0);
  const bad = [{ description: "X", taxCode: "BOGUS", quantity: 0, lineTotalVnd: -1 }];
  const errs = validateLines(bad);
  assert.ok(errs.some((e) => e.code === "TAX_MAPPING_MISSING"));
  assert.ok(errs.some((e) => e.code === "LINE_QTY_INVALID"));
});

test("validateInvoice aggregates ok=false when anything fails", () => {
  const res = validateInvoice({
    seller: { legalName: "A", taxCode: "0101010101" },
    buyer: { kind: "organization", name: "", taxCode: "x" },
    lines: [{ description: "X", taxCode: "VAT8", quantity: 1, lineTotalVnd: 1000 }],
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.length >= 2);
});

test("validateInvoice ok=true for a complete individual sale", () => {
  const res = validateInvoice({
    seller: { legalName: "A", taxCode: "0101010101" },
    buyer: { kind: "individual", name: "Chị Lan" },
    lines: [{ description: "X", taxCode: "VAT8", quantity: 1, lineTotalVnd: 1000 }],
  });
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
});

test("line-count cap is enforced (spec 12.4)", () => {
  const lines = Array.from({ length: MAX_LINES + 1 }, (_, i) => ({ description: `L${i}`, taxCode: "VAT8", quantity: 1, lineTotalVnd: 1 }));
  const res = validateInvoice({ seller: { legalName: "A", taxCode: "0101010101" }, buyer: { kind: "individual" }, lines });
  assert.ok(res.errors.some((e) => e.code === "TOO_MANY_LINES"));
});
