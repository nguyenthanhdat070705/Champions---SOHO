import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCreatePaymentRequest,
  parsePaymentIdentifier,
} from "../server/payos/validation.js";

test("normalizes a minimal payment request", () => {
  assert.deepEqual(
    parseCreatePaymentRequest({ orderCode: "12345678", amount: "50000" }),
    {
      orderCode: 12345678,
      amount: 50000,
      description: "DH2345678",
    },
  );
});

test("rejects unsafe amounts and overlong descriptions", () => {
  assert.throws(
    () => parseCreatePaymentRequest({ orderCode: 1, amount: -1 }),
    /amount must be a positive integer/,
  );
  assert.throws(
    () =>
      parseCreatePaymentRequest({
        orderCode: 1,
        amount: 1000,
        description: "LONGER THAN NINE",
      }),
    /description must contain 1-9 characters/,
  );
});

test("parses numeric order codes and payment link IDs", () => {
  assert.equal(parsePaymentIdentifier("12345"), 12345);
  assert.equal(parsePaymentIdentifier("pay_link_abc"), "pay_link_abc");
});

