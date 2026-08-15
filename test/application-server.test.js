import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationServer } from "../server/application.js";

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

test("serves Railway health, static files, and payOS routes", async (context) => {
  process.env.PAYOS_INTERNAL_API_TOKEN = "railway-test-token";
  const server = createApplicationServer();
  const address = await listen(server);
  context.after(() => close(server));

  const baseUrl = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).status, "ok");

  const staticResponse = await fetch(`${baseUrl}/`);
  assert.equal(staticResponse.status, 200);
  assert.match(staticResponse.headers.get("content-type"), /text\/html/);

  const protectedResponse = await fetch(
    `${baseUrl}/api/payos/create-payment`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderCode: 123, amount: 50000 }),
    },
  );
  assert.equal(protectedResponse.status, 401);
  assert.equal((await protectedResponse.json()).error, "RequestError");
});

