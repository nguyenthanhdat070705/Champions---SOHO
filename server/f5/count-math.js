// Functional 05 — pure stock-count variance math (spec 3.7 / 4.3). No DB, no I/O,
// so it is unit-tested and shared verbatim with the client (src/lib/inventory.ts).
// MVP posting method is `adjustment_to_counted_at_post`: the posted delta moves the
// balance to the COUNTED number using the balance CURRENT at post time — so the
// review screen shows both expected_at_start and current_before_post (spec 4.3).

const EPS = 1e-9;

export function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/**
 * Variance for one counted line.
 * @param expectedAtStart snapshot on_hand when the session started
 * @param currentOnHand   live on_hand now (may differ if a sale/receipt happened)
 * @param countedQty      physical count entered, or null if not counted / missing
 */
export function computeVariance(expectedAtStart, currentOnHand, countedQty) {
  if (countedQty == null) {
    return { counted: null, variance: null, deltaFromExpected: null, requiresReason: false, missing: true };
  }
  const counted = round3(countedQty);
  const variance = round3(counted - round3(currentOnHand));           // what posting will change
  const deltaFromExpected = round3(counted - round3(expectedAtStart)); // drift vs snapshot
  return { counted, variance, deltaFromExpected, requiresReason: Math.abs(variance) > EPS, missing: false };
}

/** The signed movement delta a post writes for a line (0 → no movement). */
export function countPostDelta(currentOnHand, countedQty) {
  if (countedQty == null) return 0;
  return round3(round3(countedQty) - round3(currentOnHand));
}

/** Roll up a set of computed variance lines into review/post summary counters. */
export function summarizeVariances(lines) {
  let increases = 0, decreases = 0, unchanged = 0, missing = 0, needsReason = 0, counted = 0;
  for (const l of lines) {
    if (l.missing || l.counted == null) { missing++; continue; }
    counted++;
    if (l.variance > EPS) increases++;
    else if (l.variance < -EPS) decreases++;
    else unchanged++;
    if (l.requiresReason && !l.reasonCode) needsReason++;
  }
  return { increases, decreases, unchanged, missing, counted, needsReason };
}
