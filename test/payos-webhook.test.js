import assert from "node:assert/strict";
import test from "node:test";
import { PayOS } from "@payos/node";
import webhookHandler from "../api/payos/webhook.js";

process.env.PAYOS_CLIENT_ID = "test-client-id";
process.env.PAYOS_API_KEY = "test-api-key";
process.env.PAYOS_CHECKSUM_KEY = "test-checksum-key";

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

async function signedWebhook(overrides = {}) {
  const data = {
    orderCode: 123,
    amount: 3000,
    description: "VQRIO123",
    accountNumber: "12345678",
    reference: "TF230204212323",
    transactionDateTime: "2023-02-04 18:25:00",
    currency: "VND",
    paymentLinkId: "124c33293c43417ab7879e14c8d9eb18",
    code: "00",
    desc: "Thanh cong",
    ...overrides,
  };
  const signer = new PayOS({
    clientId: process.env.PAYOS_CLIENT_ID,
    apiKey: process.env.PAYOS_API_KEY,
    checksumKey: process.env.PAYOS_CHECKSUM_KEY,
  });
  const signature = await signer.crypto.createSignatureFromObj(
    data,
    process.env.PAYOS_CHECKSUM_KEY,
  );

  return { code: "00", desc: "success", success: true, data, signature };
}

test("accepts the signed webhook verification event from payOS", async () => {
  const req = {
    method: "POST",
    headers: {},
    body: await signedWebhook(),
  };
  const res = createResponse();

  await webhookHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, test: true });
});

test("rejects an invalid webhook signature", async () => {
  const webhook = await signedWebhook();
  webhook.signature = "invalid";
  const req = { method: "POST", headers: {}, body: webhook };
  const res = createResponse();

  await webhookHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "InvalidWebhook");
});

test("asks payOS to retry real events until an order service is configured", async () => {
  delete process.env.PAYOS_WEBHOOK_FORWARD_URL;
  const req = {
    method: "POST",
    headers: {},
    body: await signedWebhook({
      orderCode: 987654,
      amount: 50000,
      description: "DH987654",
    }),
  };
  const res = createResponse();

  await webhookHandler(req, res);

  assert.equal(res.statusCode, 503);
  assert.match(res.body.message, /not configured/);
});

