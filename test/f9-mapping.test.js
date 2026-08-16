// Functional 09 pure-logic unit tests (no DB) — tax code/rate mapping. Part of
// `npm test` (node --test), so runs WITHOUT DATABASE_URL.
import assert from "node:assert/strict";
import test from "node:test";
import {
  RULE_SET_VERSION, TAX_CODES, DEFAULT_TAX_CODE, isValidTaxCode, taxRateOf, taxLabelOf, resolveLineTax,
} from "../server/f9/mapping.js";

test("rule set version is stamped and stable", () => {
  assert.equal(typeof RULE_SET_VERSION, "string");
  assert.match(RULE_SET_VERSION, /^retail-vn-/);
});

test("allowlisted tax codes have numeric fractional rates", () => {
  for (const [code, def] of Object.entries(TAX_CODES)) {
    assert.equal(isValidTaxCode(code), true);
    assert.equal(typeof def.rate, "number");
    assert.ok(def.rate >= 0 && def.rate < 1);
  }
  assert.equal(TAX_CODES.VAT8.rate, 0.08);
  assert.equal(TAX_CODES.VAT10.rate, 0.1);
  assert.equal(TAX_CODES.KCT.rate, 0);
});

test("unknown code is not valid and has null rate", () => {
  assert.equal(isValidTaxCode("VAT99"), false);
  assert.equal(isValidTaxCode(undefined), false);
  assert.equal(taxRateOf("VAT99"), null);
});

test("resolveLineTax defaults an unmapped line to the default code", () => {
  const r = resolveLineTax({ name: "Cà phê" });
  assert.equal(r.taxCode, DEFAULT_TAX_CODE);
  assert.equal(r.taxRate, taxRateOf(DEFAULT_TAX_CODE));
});

test("resolveLineTax honours a valid explicit override, ignores an invalid one", () => {
  assert.equal(resolveLineTax({ taxCode: "VAT10" }).taxCode, "VAT10");
  assert.equal(resolveLineTax({ taxCode: "BOGUS" }).taxCode, DEFAULT_TAX_CODE);
});

test("taxLabelOf returns a human label", () => {
  assert.equal(taxLabelOf("VAT8"), "Thuế suất 8%");
  assert.equal(taxLabelOf("KCT"), "Không chịu thuế");
});
