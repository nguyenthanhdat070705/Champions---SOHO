// Functional 09 pure-logic unit tests (no DB) — invoice state reducer: no terminal
// regression, out-of-order guard, ack-only no-op (INV-08/10). Part of `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import {
  INVOICE_STATUSES, TERMINAL_STATUSES, isTerminal, reduceProviderEvent, isEditable, canRetry, canRelate,
} from "../server/f9/state.js";

test("status list and terminal set are as specced (spec 2.1)", () => {
  for (const s of ["draft", "validation_failed", "validated", "submitting", "accepted", "rejected", "adjusted", "replaced", "cancelled"]) {
    assert.ok(INVOICE_STATUSES.includes(s));
  }
  assert.deepEqual(TERMINAL_STATUSES, ["accepted", "rejected", "adjusted", "replaced", "cancelled"]);
  assert.equal(isTerminal("accepted"), true);
  assert.equal(isTerminal("submitting"), false);
});

test("a submitting invoice accepts an 'accepted' event", () => {
  assert.equal(reduceProviderEvent("submitting", "accepted", "2026-01-01T00:00:00Z", null), "accepted");
  assert.equal(reduceProviderEvent("submitting", "rejected", "2026-01-01T00:00:00Z", null), "rejected");
});

test("only a submitting invoice can be decided (no jump from draft/validated)", () => {
  assert.equal(reduceProviderEvent("draft", "accepted", "2026-01-01T00:00:00Z", null), null);
  assert.equal(reduceProviderEvent("validated", "accepted", "2026-01-01T00:00:00Z", null), null);
});

test("a terminal invoice never regresses (INV-08 duplicate/late event)", () => {
  assert.equal(reduceProviderEvent("accepted", "rejected", "2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z"), null);
  assert.equal(reduceProviderEvent("rejected", "accepted", "2026-02-01T00:00:00Z", null), null);
});

test("an out-of-order (older) event is ignored", () => {
  // last processed event was at 12:00; a new event stamped 11:00 must not apply.
  assert.equal(reduceProviderEvent("submitting", "accepted", "2026-01-01T11:00:00Z", "2026-01-01T12:00:00Z"), null);
  // a strictly-newer event applies
  assert.equal(reduceProviderEvent("submitting", "accepted", "2026-01-01T13:00:00Z", "2026-01-01T12:00:00Z"), "accepted");
});

test("an 'ack'/'received' event is a no-op (still submitting; not accepted)", () => {
  assert.equal(reduceProviderEvent("submitting", "ack", "2026-01-01T00:00:00Z", null), null);
  assert.equal(reduceProviderEvent("submitting", "received", "2026-01-01T00:00:00Z", null), null);
});

test("an unknown event type is a no-op", () => {
  assert.equal(reduceProviderEvent("submitting", "sneezed", "2026-01-01T00:00:00Z", null), null);
});

test("edit/retry/relate gates", () => {
  assert.equal(isEditable("draft"), true);
  assert.equal(isEditable("validated"), true);
  assert.equal(isEditable("submitting"), false);
  assert.equal(canRetry("rejected"), true);
  assert.equal(canRetry("accepted"), false);
  assert.equal(canRelate("accepted"), true);
  assert.equal(canRelate("rejected"), false);
});
