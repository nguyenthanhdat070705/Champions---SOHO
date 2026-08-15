// Pure text normalisation for the catalog (Functional 04). `search_name` is
// maintained server-side on every create/rename so all clients share one
// unaccented, lowercased form (spec 8.1 / 9.1). The algorithm matches Postgres
// `unaccent(lower(x))` for Vietnamese: strip combining diacritics (incl. the
// horn/breve on ơ/ư/ă) and fold đ→d. Kept dependency-free so it is trivially
// unit-testable and identical on client and server.

/** Lowercase + strip Vietnamese diacritics + collapse whitespace. */
export function normalizeSearchName(input) {
  return String(input == null ? "" : input)
    .toLowerCase()
    .normalize("NFD")
    // remove combining marks (U+0300–U+036F covers acute/grave/hook/tilde/dot,
    // and the horn U+031B / breve U+0306 used by ơ ư ă).
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalise an SKU to its canonical stored form. SKUs are uppercased and
 * whitespace-trimmed so the merchant-scoped unique index behaves
 * case-insensitively (spec 4.2). Empty → null (SKU is optional).
 */
export function normalizeSku(input) {
  if (input == null) return null;
  const s = String(input).trim().toUpperCase().replace(/\s+/g, " ");
  return s.length ? s : null;
}

/** Normalise a barcode: trim only (barcodes are case-sensitive digits/codes). */
export function normalizeBarcode(input) {
  if (input == null) return null;
  const s = String(input).trim();
  return s.length ? s : null;
}
