// Functional 09 pure-logic unit tests (no DB) — MockProvider adapter: signature
// round-trip + tamper reject (INV-07), deterministic submission ref, artifact hashes
// (INV-11). Part of `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MockProvider, getProvider, signBody, verifyBody, buildMockXml, buildMockPdfText,
} from "../server/f9/provider.js";

test("provider is registered under its allowlisted code and labelled honestly", () => {
  assert.equal(getProvider("mock"), MockProvider);
  assert.equal(getProvider("sinvoice"), null);
  assert.match(MockProvider.label, /thử nghiệm/);
});

test("HMAC signature round-trips and rejects tampering (INV-07)", () => {
  const body = JSON.stringify({ providerEventId: "e1", eventType: "accepted" });
  const sig = signBody(body);
  assert.equal(verifyBody(body, sig), true);
  assert.equal(MockProvider.verifySignature(body, sig), true);
  assert.equal(verifyBody(body + "x", sig), false); // tampered body
  assert.equal(verifyBody(body, "deadbeef"), false); // wrong signature
  assert.equal(verifyBody(body, ""), false);
  assert.equal(verifyBody(body, undefined), false);
});

test("createSubmission returns a deterministic ref and only ACKs (never accepted)", () => {
  const a = MockProvider.createSubmission({ invoiceId: "inv1", payloadHash: "abc", clientRequestId: "soho-inv1-2" });
  const b = MockProvider.createSubmission({ invoiceId: "inv1", payloadHash: "abc", clientRequestId: "soho-inv1-2" });
  assert.equal(a.providerRef, b.providerRef); // same payload → same ref
  assert.match(a.providerRef, /^MOCK-[0-9A-F]{16}$/);
  assert.equal(a.status, "received"); // ACK, NOT accepted
  const c = MockProvider.createSubmission({ invoiceId: "inv1", payloadHash: "different", clientRequestId: "x" });
  assert.notEqual(a.providerRef, c.providerRef);
});

test("getStatus reports pending (state lives in verified events, not the mock)", () => {
  assert.equal(MockProvider.getStatus("MOCK-x").status, "pending");
});

test("artifacts build with stable hashes from the frozen snapshot (INV-11)", () => {
  const invoice = {
    id: "inv1", status: "accepted", ruleSetVersion: "r", payloadHash: "hhh", providerInvoiceRef: "MOCK-ABCDEF0123456789",
    sellerSnapshot: { legalName: "Cửa hàng A", taxCode: "0101010101" },
    buyerSnapshot: { kind: "individual", name: "Chị Lan" },
    subtotalVnd: 50000, taxVnd: 4000, totalVnd: 54000,
    items: [{ description: "Bánh mì", quantity: 2, unitPriceVnd: 27000, taxCode: "VAT8", lineTotalVnd: 54000, taxVnd: 4000 }],
  };
  const art = MockProvider.buildArtifacts(invoice);
  assert.match(art.xml.contentType, /xml/);
  assert.match(art.xml.hash, /^[0-9a-f]{64}$/);
  assert.match(art.pdf.hash, /^[0-9a-f]{64}$/);
  // deterministic
  assert.equal(MockProvider.buildArtifacts(invoice).xml.hash, art.xml.hash);
  // honest labelling inside the placeholder content
  assert.match(buildMockXml(invoice), /TEST PLACEHOLDER/);
  assert.match(buildMockPdfText(invoice), /BẢN THỬ NGHIỆM/);
  assert.match(art.xml.body, /Chị Lan/); // buyer snapshot present
});
