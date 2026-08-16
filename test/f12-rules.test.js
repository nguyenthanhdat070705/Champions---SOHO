// Functional 12 pure-logic tests (spec 6 REC-FR-02/03/04, 13.3 determinism).
// No DB — these pin the fingerprint/canonicalisation contract and the rule
// catalog mappers. Run: node --test test/f12-rules.test.js (part of `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, canonicalJson, fingerprint, contentHash } from "../server/f12/fingerprint.js";
import { RULES, RULES_BY_ID, RULE_VERSION, FAMILIES, IMPACTS } from "../server/f12/rules.js";

test("canonicalize sorts object keys recursively; arrays keep order", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: { z: 1, y: 2 } }), '{"a":{"y":2,"z":1}}');
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]"); // array order preserved
  assert.deepEqual(canonicalize({ b: 1, a: 2 }), { a: 2, b: 1 });
});

test("fingerprint is deterministic and stable across key-independent facts", () => {
  const a = fingerprint("ORDER_PAID_NO_PAYMENT", RULE_VERSION, "order:123");
  const b = fingerprint("ORDER_PAID_NO_PAYMENT", RULE_VERSION, "order:123");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("fingerprint differs by rule, version and entity", () => {
  const base = fingerprint("R1", "v1", "order:1");
  assert.notEqual(base, fingerprint("R2", "v1", "order:1"));
  assert.notEqual(base, fingerprint("R1", "v2", "order:1"));
  assert.notEqual(base, fingerprint("R1", "v1", "order:2"));
});

test("contentHash ignores key order but reflects value drift", () => {
  assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
  assert.notEqual(contentHash({ a: 1, b: 2 }), contentHash({ a: 1, b: 3 }));
});

test("rule catalog: unique ids, valid family/impact, complete shape", () => {
  const ids = new Set();
  for (const r of RULES) {
    assert.equal(ids.has(r.id), false, `duplicate rule id ${r.id}`);
    ids.add(r.id);
    assert.ok(FAMILIES.includes(r.family), `bad family ${r.family}`);
    assert.ok(IMPACTS.includes(r.impact), `bad impact ${r.impact}`);
    assert.equal(typeof r.detectSql, "string");
    assert.equal(typeof r.recheckSql, "string");
    assert.equal(typeof r.map, "function");
    assert.equal(typeof r.explain, "function");
    assert.equal(typeof r.command, "string");
    // recheckSql is scoped to a single entity by $2 (merchant=$1, entity=$2).
    assert.match(r.recheckSql, /\$2/, `${r.id} recheckSql missing $2`);
    assert.doesNotMatch(r.recheckSql, /\$3/, `${r.id} recheckSql should not use $3`);
  }
  assert.ok(RULES.length >= 6, "expected at least 6 rules");
  assert.equal(RULES_BY_ID.ORDER_PAID_NO_PAYMENT.impact, "high");
});

test("mappers coerce bigint strings to numbers and build a PII-free entity key", () => {
  const m = RULES_BY_ID.ORDER_PAID_NO_PAYMENT.map({
    id: "11111111-1111-1111-1111-111111111111", order_number: "HD-1",
    total_amount: "450000", status: "paid", version: "3", paid_at: "2026-08-16T00:00:00Z",
  });
  assert.equal(m.entityKey, "order:11111111-1111-1111-1111-111111111111");
  assert.equal(m.source.type, "order");
  assert.equal(m.source.version, 3);
  assert.equal(m.facts.totalAmount, 450000);
  assert.equal(typeof m.facts.totalAmount, "number");
  assert.equal(m.facts.capturedTotal, 0);
  assert.equal(m.deepLink.route, "/don-hang/11111111-1111-1111-1111-111111111111");
});

test("amount-mismatch mapper computes signed diff", () => {
  const m = RULES_BY_ID.ORDER_PAYMENT_TOTAL_MISMATCH.map({
    id: "abc", order_number: "HD-2", total_amount: "200000", status: "paid", version: "1", captured: "150000",
  });
  assert.equal(m.facts.totalAmount, 200000);
  assert.equal(m.facts.capturedTotal, 150000);
  assert.equal(m.facts.diff, -50000);
});

test("ledger-drift mapper keys on product and computes diff", () => {
  const m = RULES_BY_ID.INVENTORY_LEDGER_DRIFT.map({
    product_id: "p1", on_hand: "5", row_version: "9", ledger_sum: "3", product_name: "Cà phê",
  });
  assert.equal(m.entityKey, "product:p1");
  assert.equal(m.facts.diff, 2);
  assert.equal(m.deepLink.route, "/ton-kho/p1");
});
