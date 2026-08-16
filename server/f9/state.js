// Functional 09 — invoice state machine + provider-event reducer (spec 2.1, 4.2).
// Pure logic so it is exhaustively unit-tested. The golden rule: a verified provider
// event is the ONLY thing that can move an invoice to accepted/rejected (spec 7.2),
// and a terminal state can never regress — an out-of-order or duplicate event only
// appends audit, it does not roll the status back (spec 4.2 "reducer").

/** All invoice statuses (spec 8.2 check constraint). */
export const INVOICE_STATUSES = [
  "draft", "validation_failed", "validated", "submitting",
  "accepted", "rejected", "adjusted", "replaced", "cancelled",
];

/** Terminal states: no automatic transition may leave these (spec 2.1). */
export const TERMINAL_STATUSES = ["accepted", "rejected", "adjusted", "replaced", "cancelled"];

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/** Provider event type → the invoice status it would drive (spec 4.2). */
export const EVENT_STATUS = {
  accepted: "accepted",
  rejected: "rejected",
  // An intermediate 'ack'/'received' keeps the invoice in submitting.
  ack: "submitting",
  received: "submitting",
};

/**
 * Decide the next status from a verified provider event, or null for "no change".
 * Guards (spec 4.2):
 *  - the event must map to a known status,
 *  - only an invoice currently `submitting` may become accepted/rejected,
 *  - a terminal invoice never transitions again,
 *  - an event older than the last processed event is ignored (out-of-order).
 * @returns {string|null} next status, or null if the event is a no-op
 */
export function reduceProviderEvent(current, eventType, occurredAt, lastEventAt) {
  const next = EVENT_STATUS[eventType];
  if (!next) return null;
  if (isTerminal(current)) return null; // never leave a terminal state
  if (next === "submitting") return null; // ack of an already-submitting invoice: no-op
  if (current !== "submitting") return null; // only a submitted invoice can be decided
  // Out-of-order guard: ignore an event strictly older than the last one seen.
  if (lastEventAt && occurredAt && new Date(occurredAt).getTime() < new Date(lastEventAt).getTime()) {
    return null;
  }
  return next; // accepted | rejected
}

/** Statuses a buyer/line edit is still allowed in (before freeze). */
export function isEditable(status) {
  return status === "draft" || status === "validation_failed" || status === "validated";
}

/** A rejected invoice can be cloned into a retry-draft (spec 4.3). */
export function canRetry(status) {
  return status === "rejected";
}

/** An accepted invoice can spawn an adjustment/replacement relation (spec 4.3). */
export function canRelate(status) {
  return status === "accepted";
}
