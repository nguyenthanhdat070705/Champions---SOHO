// Functional 08 — pure-logic unit tests for the document-box validators/allowlists
// (server/f8/types.js). No DB/network. Runs under `node --test` in `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BYTES, ALLOWED_MIME, DOCUMENT_TYPES, LINK_TYPES, TARGET_TYPES,
  extForMime, requireAllowedMime, requireAllowedSize, normalizeDocumentType,
  requireLinkType, requireTargetType, targetRoute,
} from "../server/f8/types.js";

test("MIME allowlist mirrors the deployed bucket (image only, no pdf)", () => {
  assert.deepEqual(ALLOWED_MIME, ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(requireAllowedMime("image/jpeg"), "image/jpeg");
  assert.equal(requireAllowedMime("IMAGE/PNG"), "image/png"); // case-insensitive
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(code(() => requireAllowedMime("application/pdf")), "DOCUMENT_MIME_UNSUPPORTED");
  assert.equal(code(() => requireAllowedMime("application/octet-stream")), "DOCUMENT_MIME_UNSUPPORTED");
  assert.equal(code(() => requireAllowedMime("")), "DOCUMENT_MIME_UNSUPPORTED");
});

test("extForMime maps to the storage-friendly extension", () => {
  assert.equal(extForMime("image/jpeg"), "jpg");
  assert.equal(extForMime("image/png"), "png");
  assert.equal(extForMime("image/webp"), "webp");
  assert.equal(extForMime("nope"), "bin");
});

test("size gate: >0 and ≤ 10 MiB", () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(requireAllowedSize(1), 1);
  assert.equal(requireAllowedSize(MAX_BYTES), MAX_BYTES);
  assert.equal(code(() => requireAllowedSize(0)), "VALIDATION");
  assert.equal(code(() => requireAllowedSize(-5)), "VALIDATION");
  assert.equal(code(() => requireAllowedSize(MAX_BYTES + 1)), "DOCUMENT_TOO_LARGE");
});

test("document_type normalizes to the allowlist, unknown/blank → null (a hint)", () => {
  for (const t of DOCUMENT_TYPES) assert.equal(normalizeDocumentType(t), t);
  assert.equal(normalizeDocumentType("EXPENSE"), "expense");
  assert.equal(normalizeDocumentType("random"), null);
  assert.equal(normalizeDocumentType(""), null);
  assert.equal(normalizeDocumentType(undefined), null);
  assert.ok(DOCUMENT_TYPES.includes("other"));
});

test("link_type allowlist", () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.deepEqual(LINK_TYPES, ["primary", "supporting", "other"]);
  assert.equal(requireLinkType("primary"), "primary");
  assert.equal(requireLinkType("SUPPORTING"), "supporting");
  assert.equal(code(() => requireLinkType("boss")), "VALIDATION");
});

test("target_type allowlist + deep-link routes", () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.deepEqual(Object.keys(TARGET_TYPES).sort(), ["expense", "order", "purchase_receipt"]);
  assert.equal(requireTargetType("order"), "order");
  assert.equal(code(() => requireTargetType("invoice_xyz")), "VALIDATION");
  assert.equal(targetRoute("order", "abc"), "/don-hang/abc");
  assert.equal(targetRoute("expense", "e1"), "/chi-phi/e1");
  assert.equal(targetRoute("purchase_receipt", "p1"), "/nhap-hang/p1");
  assert.equal(targetRoute("unknown", "x"), null);
});
