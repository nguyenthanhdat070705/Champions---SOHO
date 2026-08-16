import { describe, it, expect } from "vitest";
import { proceedDecision, canLockCreated } from "./checkout";

describe("proceedDecision (POS lock-flow guard)", () => {
  it("locks the current cart when there is no outstanding bill", () => {
    expect(proceedDecision(null, null)).toBe("lock-current");
    expect(proceedDecision(undefined, "order-1")).toBe("lock-current");
  });

  it("shows the dialog when a DIFFERENT bill is still awaiting payment", () => {
    // The stale-payment repro: a new cart (currentOrder null) with an old
    // awaiting bill outstanding must NOT auto-proceed.
    expect(proceedDecision("stale-24k", null)).toBe("show-dialog");
    expect(proceedDecision("stale-24k", "current-draft")).toBe("show-dialog");
  });

  it("does not flag the current live order as outstanding", () => {
    // e.g. a QR-pending bill that stayed awaiting after back-navigation is our
    // own current order, not a separate outstanding one.
    expect(proceedDecision("order-1", "order-1")).toBe("lock-current");
  });
});

describe("canLockCreated (never lock a replayed non-draft order)", () => {
  it("allows locking a fresh draft", () => {
    expect(canLockCreated("draft")).toBe(true);
  });

  it("blocks locking a replayed awaiting/paid/cancelled order", () => {
    for (const s of ["awaiting_payment", "paid", "cancelled", "refunded"]) {
      expect(canLockCreated(s)).toBe(false);
    }
  });
});
