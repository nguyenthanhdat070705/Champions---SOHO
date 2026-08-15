// Functional 05 — pure movement rules (no DB), so they are unit-tested and shared.
// A reversal only applies to the manual-correction family (spec 4.2); money-linked
// movements (sale/return/receipt/opening) are corrected through their own flows,
// never reverted here. A reversal's delta is exactly the negation of the original.

/** Movement types F05 may reverse (spec 4.2 reversal source = a manual movement). */
export const REVERSIBLE_MOVEMENT_TYPES = new Set(["manual_adjustment", "count_adjustment"]);

export function isReversibleType(movementType) {
  return REVERSIBLE_MOVEMENT_TYPES.has(movementType);
}

function r3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/** The signed delta a reversal writes = -original (spec 4.2). */
export function reverseDelta(originalDelta) {
  return r3(-Number(originalDelta));
}

/** The signed delta a manual adjustment writes from a direction + magnitude. */
export function adjustmentDelta(direction, quantity) {
  const q = r3(quantity);
  return direction === "increase" ? q : -q;
}
