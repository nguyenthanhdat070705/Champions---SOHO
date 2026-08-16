// Functional 09 — tax code/rate mapping (spec 4.1, 3.5). A small, versioned retail
// mapping table lives in code (the "rule service" of the spec, MVP form). The final
// tax code/rate NEVER comes from AI or the client — it is resolved here and frozen
// into the invoice with `rule_set_version` stamped, so a later rule change can never
// silently rewrite a past invoice (spec 7.2). A real rule provider later = swap this
// module; the frozen snapshot on old invoices is unaffected.

/** Bump when the table below changes; stamped onto every invoice at draft time. */
export const RULE_SET_VERSION = "retail-vn-2025.08";

/**
 * Allowlisted tax codes and their rates. Household-retail MVP set. VAT8 is the
 * current common reduced retail rate; KCT = không chịu thuế (not subject).
 * rate is a fraction (0.08 = 8%).
 */
export const TAX_CODES = {
  KCT: { rate: 0, label: "Không chịu thuế" },
  VAT0: { rate: 0, label: "Thuế suất 0%" },
  VAT5: { rate: 0.05, label: "Thuế suất 5%" },
  VAT8: { rate: 0.08, label: "Thuế suất 8%" },
  VAT10: { rate: 0.1, label: "Thuế suất 10%" },
};

/** Default code for a retail line when the product carries no explicit tax profile. */
export const DEFAULT_TAX_CODE = "VAT8";

/** True if `code` is one of the allowlisted tax codes. */
export function isValidTaxCode(code) {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(TAX_CODES, code);
}

/** Fractional rate for a code, or null if the code is unknown. */
export function taxRateOf(code) {
  return isValidTaxCode(code) ? TAX_CODES[code].rate : null;
}

/** Human label for a code (for the UI badge), or the raw code if unknown. */
export function taxLabelOf(code) {
  return isValidTaxCode(code) ? TAX_CODES[code].label : String(code);
}

/**
 * Resolve the tax code for one order line. Products in this MVP carry no tax
 * profile column, so every retail line maps to the default; the seam is here so a
 * real product→tax-profile join drops in without touching callers. An explicit
 * override (e.g. a future product.tax_code) wins when present and allowlisted.
 * @returns {{ taxCode: string, taxRate: number }}
 */
export function resolveLineTax(line = {}) {
  const override = line.taxCode;
  const code = isValidTaxCode(override) ? override : DEFAULT_TAX_CODE;
  return { taxCode: code, taxRate: taxRateOf(code) };
}
