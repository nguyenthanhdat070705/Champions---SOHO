// Pure decision logic for the POS "Tiếp tục thanh toán" lock flow (F3).
//
// Extracted from SalesFlow so the guard that fixes the stale-payment bug is
// unit-testable. Background: the server's createOrder is idempotent on
// client_request_id — if the client reuses an id bound to an older order, the
// server replays THAT order (with its old total) instead of building a new one
// from the current cart. These helpers keep the client from ever silently
// proceeding to payment on such a replayed / still-outstanding bill.

/** What proceedToPayment should do after probing for an outstanding bill. */
export type ProceedAction = "show-dialog" | "lock-current";

/**
 * Given the outstanding awaiting_payment bill returned by the server probe (or
 * null) and the id of the current live order, decide whether to surface the
 * explicit choice dialog or lock the current cart. Any outstanding bill that is
 * not the current order blocks an automatic proceed.
 */
export function proceedDecision(
  outstandingOrderId: string | null | undefined,
  currentOrderId: string | null | undefined,
): ProceedAction {
  if (outstandingOrderId && outstandingOrderId !== currentOrderId) return "show-dialog";
  return "lock-current";
}

/**
 * After create/replay, an order may be locked as the current bill ONLY if it is
 * still a draft. A non-draft result means createOrder replayed an existing
 * (awaiting/paid/cancelled) order bound to a reused client_request_id — that
 * must be surfaced, never locked.
 */
export function canLockCreated(status: string): boolean {
  return status === "draft";
}
