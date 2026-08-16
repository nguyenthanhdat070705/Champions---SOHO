// Functional 06 — pure money/dedupe logic for goods receiving (spec 4.1 / 4.3).
// Kept dependency-free (except node:crypto for the content hash, which is
// deterministic) so it is unit-tested (test/f6-receiving.test.js) and can never
// drift between the server and its callers. The SERVER always computes line/
// subtotal/grand totals here — a client- or OCR-supplied total is only ever an
// advisory cross-check, never trusted (REC-02 / REC-FR-06 / spec 7.1).
import { createHash } from "node:crypto";

/** numeric(14,3) rounding so JS float math matches the DB quantity column. */
export function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/** Coerce to a non-negative integer VND (bigint column); throws-free helper. */
function toVndInt(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * line_total = round(quantity × unit_cost) in whole VND (spec 4.1). Quantity is
 * numeric(14,3); unit cost + total are bigint VND. Rounded to the đồng.
 */
export function lineTotal(quantity, unitCostVnd) {
  const q = round3(quantity);
  const c = toVndInt(unitCostVnd);
  return Math.round(q * c);
}

/**
 * Recompute all monetary totals for a receipt from its lines + extra cost.
 * subtotal = Σ line_total; grand_total = subtotal + extra_cost (spec 4.1). MVP
 * does NOT allocate extra_cost into per-unit cost — it is stored separately for
 * the accounting functional (spec 4.1 note).
 * @param {Array<{quantity:number, unitCostVnd:number}>} lines
 * @param {number} extraCostVnd
 */
export function computeTotals(lines, extraCostVnd = 0) {
  const items = Array.isArray(lines) ? lines : [];
  let subtotal = 0;
  const lineTotals = items.map((l) => {
    const lt = lineTotal(l.quantity, l.unitCostVnd);
    subtotal += lt;
    return lt;
  });
  const extra = toVndInt(extraCostVnd);
  return { lineTotals, subtotalVnd: subtotal, extraCostVnd: extra, grandTotalVnd: subtotal + extra };
}

/**
 * Content hash of the raw document bytes for exact-duplicate detection (spec
 * 8.3 content_hash). Deterministic sha256 of the base64 payload's decoded bytes.
 * @param {Buffer|string} bytesOrBase64
 */
export function contentHash(bytesOrBase64) {
  const buf = Buffer.isBuffer(bytesOrBase64)
    ? bytesOrBase64
    : Buffer.from(String(bytesOrBase64 || ""), "base64");
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * A coarse perceptual-ish signature that survives NOTHING but exact re-encoding
 * — a lightweight fingerprint over evenly-sampled bytes + total size. It is a
 * SUPPORTING signal only (spec 4.3 "Hash là tín hiệu hỗ trợ; không tự kết luận
 * trùng"); real near-dup matching needs pixel decoding, out of MVP scope. Stored
 * so a future extractor can strengthen dedup without a re-upload.
 */
export function perceptualHash(bytesOrBase64) {
  const buf = Buffer.isBuffer(bytesOrBase64)
    ? bytesOrBase64
    : Buffer.from(String(bytesOrBase64 || ""), "base64");
  if (buf.length === 0) return null;
  const samples = 64;
  const step = Math.max(1, Math.floor(buf.length / samples));
  const picked = [];
  for (let i = 0; i < buf.length && picked.length < samples; i += step) picked.push(buf[i]);
  const h = createHash("sha1").update(Buffer.from(picked)).digest("hex").slice(0, 16);
  return `${buf.length.toString(16)}:${h}`;
}

/**
 * Score how strongly an existing document/receipt looks like a duplicate of a
 * new one (spec 4.3). Exact content-hash is the strongest signal; a matching
 * document_number is strong; a matching (supplier, date, total) triple is a
 * softer heuristic. Returns a level so the caller can WARN (never hard-block by
 * hash alone — spec "cảnh báo không đồng nghĩa chắc chắn trùng").
 * @returns {"exact"|"strong"|"soft"|null}
 */
export function duplicateLevel(candidate, incoming) {
  if (candidate.contentHash && incoming.contentHash && candidate.contentHash === incoming.contentHash) {
    return "exact";
  }
  // Case- + diacritic-insensitive compare (Vietnamese supplier names vary in
  // accents between OCR and manual entry).
  const num = (x) =>
    x == null
      ? ""
      : String(x).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/\s+/g, " ").trim();
  if (num(candidate.documentNumber) && num(candidate.documentNumber) === num(incoming.documentNumber)) {
    return "strong";
  }
  const sameSupplier = num(candidate.supplier) && num(candidate.supplier) === num(incoming.supplier);
  const sameDate = num(candidate.receivedDate) && num(candidate.receivedDate) === num(incoming.receivedDate);
  const sameTotal = candidate.totalVnd != null && incoming.totalVnd != null && Number(candidate.totalVnd) === Number(incoming.totalVnd);
  if (sameSupplier && sameDate && sameTotal) return "soft";
  return null;
}
