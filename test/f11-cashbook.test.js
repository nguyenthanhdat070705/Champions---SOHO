// Functional 11 pure-logic unit tests (no DB) — the deterministic source→cashbook
// mapping, method normalization, draft-ready gate, source hashing and period math.
// Part of `npm test` (node --test), so they run WITHOUT DATABASE_URL.
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySource, mapPaymentMethod, draftIsReady, directionForEntryType,
  sourceHash, lookupMapping, RULE_VERSION, ENTRY_TYPES,
} from "../server/f11/mapping.js";
import { computePeriod } from "../server/f11/cashbook.js";

// ── Mapping: auto-post the certain money-in/out (spec §4.1, §12.4) ─────────────
test("payment succeeded → posted 'in' sales_receipt, method from source", () => {
  const d = classifySource({
    sourceType: "payment", sourceEventType: "payment.succeeded",
    amountVnd: 320000, occurredAt: "2026-08-16T09:30:00+07:00", paymentMethod: "cash",
  });
  assert.equal(d.decision, "post");
  assert.equal(d.direction, "in");
  assert.equal(d.entryType, "sales_receipt");
  assert.equal(d.paymentMethod, "cash");
  assert.equal(d.amountVnd, 320000);
  assert.equal(d.ruleVersion, RULE_VERSION);
});

test("qr payment maps to transfer method", () => {
  const d = classifySource({
    sourceType: "payment", sourceEventType: "payment.succeeded",
    amountVnd: 50000, occurredAt: "2026-08-16T10:00:00+07:00", paymentMethod: "qr",
  });
  assert.equal(d.decision, "post");
  assert.equal(d.paymentMethod, "transfer");
});

test("refund succeeded → posted 'out' sales_refund", () => {
  const d = classifySource({
    sourceType: "refund", sourceEventType: "refund.succeeded",
    amountVnd: 20000, occurredAt: "2026-08-16T11:00:00+07:00", paymentMethod: "cash",
  });
  assert.equal(d.decision, "post");
  assert.equal(d.direction, "out");
  assert.equal(d.entryType, "sales_refund");
});

// ── Mapping: never guess — downgrade to review (spec §4.2, CBK-03) ─────────────
test("payment missing occurred_at → review, not post", () => {
  const d = classifySource({
    sourceType: "payment", sourceEventType: "payment.succeeded",
    amountVnd: 320000, occurredAt: null, paymentMethod: "cash",
  });
  assert.equal(d.decision, "review");
  assert.ok(d.reasonCodes.includes("missing_date"));
});

test("purchase accounting event → review (needs payment confirmation), never auto-post", () => {
  const d = classifySource({
    sourceType: "purchase_receipt", sourceEventType: "purchase_received",
    amountVnd: 1280000, occurredAt: "2026-08-16T08:00:00+07:00", paymentMethod: null,
  });
  assert.equal(d.decision, "review");
  assert.equal(d.direction, "out");
  assert.equal(d.entryType, "inventory_purchase");
  assert.ok(d.reasonCodes.includes("needs_payment_confirmation"));
  assert.ok(d.reasonCodes.includes("missing_payment_method"));
});

test("expense_posted event → review with missing_payment_method (accounting_events carries no method)", () => {
  const d = classifySource({
    sourceType: "expense", sourceEventType: "expense_posted",
    amountVnd: 500000, occurredAt: "2026-08-16T08:00:00+07:00", paymentMethod: null,
  });
  assert.equal(d.decision, "review");
  assert.equal(d.entryType, "operating_expense");
  assert.ok(d.reasonCodes.includes("missing_payment_method"));
});

test("zero/negative amount → review with abnormal_amount", () => {
  const d = classifySource({
    sourceType: "payment", sourceEventType: "payment.succeeded",
    amountVnd: 0, occurredAt: "2026-08-16T09:30:00+07:00", paymentMethod: "cash",
  });
  assert.equal(d.decision, "review");
  assert.ok(d.reasonCodes.includes("abnormal_amount"));
});

test("unknown source event → skip (not this feature's concern)", () => {
  const d = classifySource({ sourceType: "widget", sourceEventType: "whatever", amountVnd: 1, occurredAt: "x" });
  assert.equal(d.decision, "skip");
});

test("mapPaymentMethod normalizes to the cashbook fact vocabulary", () => {
  assert.equal(mapPaymentMethod("cash"), "cash");
  assert.equal(mapPaymentMethod("qr"), "transfer");
  assert.equal(mapPaymentMethod("bank_transfer"), "transfer");
  assert.equal(mapPaymentMethod("other"), "other");
  assert.equal(mapPaymentMethod(null), "unknown");
  assert.equal(mapPaymentMethod("weird"), "unknown");
});

test("lookupMapping resolves the built-but-not-yet-firing F07/F06 sources", () => {
  assert.ok(lookupMapping("purchase_receipt", "purchase_received"));
  assert.ok(lookupMapping("expense", "expense_posted"));
  assert.equal(lookupMapping("nope", "nope"), null);
});

// ── Draft-ready gate + direction taxonomy ──────────────────────────────────────
test("draftIsReady requires direction, valid type, amount>0, date and a method", () => {
  const good = { direction: "out", entryType: "operating_expense", amountVnd: 100, occurredAt: "2026-08-16T00:00:00+07:00", paymentMethod: "cash" };
  assert.equal(draftIsReady(good), true);
  assert.equal(draftIsReady({ ...good, amountVnd: 0 }), false);
  assert.equal(draftIsReady({ ...good, occurredAt: null }), false);
  assert.equal(draftIsReady({ ...good, entryType: "not_a_type" }), false);
  assert.equal(draftIsReady({ ...good, paymentMethod: "banana" }), false);
});

test("directionForEntryType pins the taxonomy direction; adjustment keeps fallback", () => {
  assert.equal(directionForEntryType("sales_receipt", "out"), "in");
  assert.equal(directionForEntryType("operating_expense", "in"), "out");
  assert.equal(directionForEntryType("adjustment", "in"), "in");
  assert.equal(ENTRY_TYPES.sales_refund.direction, "out");
});

// ── Source hashing (spec §5 CBK_004/CBK_005) ───────────────────────────────────
test("sourceHash is stable and changes when the amount changes", () => {
  const base = { sourceType: "payment", sourceId: "p1", sourceEventType: "payment.succeeded", amountVnd: 100, occurredAt: "t", paymentMethod: "cash" };
  assert.equal(sourceHash(base), sourceHash({ ...base }));
  assert.notEqual(sourceHash(base), sourceHash({ ...base, amountVnd: 101 }));
});

// ── Period math (spec §3.1/§3.8, CBK-10 Asia/Ho_Chi_Minh, fixed +07) ───────────
test("computePeriod today → single local day, [00:00+07, next 00:00+07)", () => {
  const now = new Date("2026-08-16T02:00:00+07:00"); // early morning VN
  const p = computePeriod("today", { now });
  assert.equal(p.dStart, "2026-08-16");
  assert.equal(p.dEnd, "2026-08-16");
  assert.equal(p.tsStart, "2026-08-16T00:00:00+07:00");
  assert.equal(p.tsEnd, "2026-08-17T00:00:00+07:00");
});

test("computePeriod today uses VN local day even near UTC midnight", () => {
  // 2026-08-16T23:30Z is already 2026-08-17 06:30 in VN.
  const now = new Date("2026-08-16T23:30:00Z");
  const p = computePeriod("today", { now });
  assert.equal(p.dStart, "2026-08-17");
});

test("computePeriod week → Monday..Sunday containing the day", () => {
  const now = new Date("2026-08-16T12:00:00+07:00"); // Sunday
  const p = computePeriod("week", { now });
  assert.equal(p.dStart, "2026-08-10"); // Monday
  assert.equal(p.dEnd, "2026-08-16");   // Sunday
});

test("computePeriod month → first..last day", () => {
  const now = new Date("2026-08-16T12:00:00+07:00");
  const p = computePeriod("month", { now });
  assert.equal(p.dStart, "2026-08-01");
  assert.equal(p.dEnd, "2026-08-31");
  assert.equal(p.tsEnd, "2026-09-01T00:00:00+07:00");
});

test("computePeriod custom swaps reversed bounds", () => {
  const p = computePeriod("custom", { from: "2026-08-20", to: "2026-08-10" });
  assert.equal(p.dStart, "2026-08-10");
  assert.equal(p.dEnd, "2026-08-20");
});
