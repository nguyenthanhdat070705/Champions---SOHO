import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApplicationServer } from "../server/application.js";

// Serve from a committed fixture so this test never depends on `npm run build`.
const siteRoot = fileURLToPath(new URL("./fixtures/site", import.meta.url));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("serves health, static shell, SPA fallback, and payOS routes", async (context) => {
  process.env.PAYOS_INTERNAL_API_TOKEN = "railway-test-token";
  const server = createApplicationServer({ siteRoot });
  const address = await listen(server);
  context.after(() => close(server));

  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Railway health check.
  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).status, "ok");

  // Static index at root.
  const staticResponse = await fetch(`${baseUrl}/`);
  assert.equal(staticResponse.status, 200);
  assert.match(staticResponse.headers.get("content-type"), /text\/html/);

  // SPA fallback: an unknown app route (no file extension) returns index.html.
  const deepLink = await fetch(`${baseUrl}/cai-dat`);
  assert.equal(deepLink.status, 200);
  assert.match(deepLink.headers.get("content-type"), /text\/html/);

  // A missing asset (has an extension) stays an honest 404.
  const missingAsset = await fetch(`${baseUrl}/nope.png`);
  assert.equal(missingAsset.status, 404);

  // PayOS create-payment is protected by the internal API token.
  const protectedResponse = await fetch(`${baseUrl}/api/payos/create-payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderCode: 123, amount: 50000 }),
  });
  assert.equal(protectedResponse.status, 401);
  assert.equal((await protectedResponse.json()).error, "RequestError");
});
