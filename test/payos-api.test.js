import assert from "node:assert/strict";
import test from "node:test";
import createPaymentHandler from "../api/payos/create-payment.js";

function createResponse() {
  return {
    body: null,
    headers: new Map(),
    statusCode: null,
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

test("protects payment creation with the internal API token", async () => {
  process.env.PAYOS_INTERNAL_API_TOKEN = "test-internal-token";
  const req = {
    method: "POST",
    headers: {},
    body: { orderCode: 123, amount: 50000 },
  };
  const res = createResponse();

  await createPaymentHandler(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "RequestError");
});

