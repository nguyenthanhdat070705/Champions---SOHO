import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, mapPgError, ERROR_STATUS } from "../server/f3/errors.js";

test("DomainError carries code + http status from the contract", () => {
  const e = new DomainError("VERSION_CONFLICT");
  assert.equal(e.code, "VERSION_CONFLICT");
  assert.equal(e.status, 409);
  assert.match(e.message, /thiết bị khác/);
});

test("every contract code has an http status", () => {
  for (const code of ["PRICE_CHANGED", "INSUFFICIENT_STOCK", "PAYMENT_ALREADY_SUCCEEDED", "REFUND_EXCEEDS_AVAILABLE", "FORBIDDEN", "QR_CONNECTION_UNAVAILABLE"]) {
    assert.ok(ERROR_STATUS[code], `${code} missing status`);
  }
});

test("mapPgError: raised FORBIDDEN (P0001) → DomainError FORBIDDEN 403", () => {
  const e = mapPgError({ code: "P0001", message: "FORBIDDEN" });
  assert.ok(e instanceof DomainError);
  assert.equal(e.code, "FORBIDDEN");
  assert.equal(e.status, 403);
});

test("mapPgError: one-successful-payment unique → PAYMENT_ALREADY_SUCCEEDED", () => {
  const e = mapPgError({ code: "23505", message: 'duplicate key value violates unique constraint "one_successful_payment_per_order"' });
  assert.equal(e.code, "PAYMENT_ALREADY_SUCCEEDED");
  assert.equal(e.status, 409);
});

test("mapPgError: idempotency unique → IDEMPOTENCY_PAYLOAD_MISMATCH", () => {
  const e = mapPgError({ code: "23505", message: 'violates unique constraint "payments_idempotency_unique"' });
  assert.equal(e.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
});

test("mapPgError: check/not-null violation → VALIDATION 400", () => {
  assert.equal(mapPgError({ code: "23514", message: "x" }).code, "VALIDATION");
  assert.equal(mapPgError({ code: "23502", message: "y" }).code, "VALIDATION");
});

test("mapPgError passes through an unknown error unchanged", () => {
  const raw = new Error("boom");
  assert.equal(mapPgError(raw), raw);
});

test("mapPgError leaves an existing DomainError intact", () => {
  const d = new DomainError("PRICE_CHANGED");
  assert.equal(mapPgError(d), d);
});
