// Pure cart model for the POS flow. No React/network here so it's trivially
// testable and can be persisted verbatim to localStorage (one active draft per
// user/device, FR-01). The server is authoritative for all money (FR-04); the
// `localEstimate` here is only for instant UI before the debounced preview
// returns.
import type { AdjustmentInput, ApiProduct, CartItemInput } from "../lib/api";

export interface LineDiscount {
  kind: "percent" | "fixed";
  rate?: number;
  amount?: number;
  reasonCode?: string;
  note?: string;
}

export interface CartLine {
  productId: string | null;
  name: string;
  unitPrice: number;
  unitCode: string;
  trackInventory: boolean;
  allowDiscount: boolean;
  onHand: number | null;
  quantity: number;
  note?: string | null;
  discount?: LineDiscount | null;
}

export interface CartState {
  lines: CartLine[];
  orderDiscount?: LineDiscount | null;
  note?: string;
}

export function emptyCart(): CartState {
  return { lines: [], orderDiscount: null, note: "" };
}

export function lineKey(line: CartLine, idx: number): string {
  return line.productId ?? `manual-${idx}`;
}

function clone(state: CartState): CartState {
  return { lines: state.lines.map((l) => ({ ...l })), orderDiscount: state.orderDiscount ? { ...state.orderDiscount } : null, note: state.note };
}

/** Add a catalog product (or +1 if already in the cart). */
export function addProduct(state: CartState, p: ApiProduct): CartState {
  const next = clone(state);
  const existing = next.lines.find((l) => l.productId === p.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    next.lines.push({
      productId: p.id, name: p.name, unitPrice: p.salePrice, unitCode: p.unitCode,
      trackInventory: p.trackInventory, allowDiscount: p.allowDiscount, onHand: p.onHand,
      quantity: 1, note: null, discount: null,
    });
  }
  return next;
}

export function setQuantity(state: CartState, index: number, quantity: number): CartState {
  const next = clone(state);
  if (next.lines[index]) next.lines[index].quantity = Math.max(0, quantity);
  return next;
}

export function incLine(state: CartState, index: number): CartState {
  const next = clone(state);
  if (next.lines[index]) next.lines[index].quantity += 1;
  return next;
}

export function decLine(state: CartState, index: number): CartState {
  const next = clone(state);
  if (next.lines[index]) next.lines[index].quantity = Math.max(0, next.lines[index].quantity - 1);
  return next;
}

export function removeLine(state: CartState, index: number): CartState {
  const next = clone(state);
  next.lines.splice(index, 1);
  return next;
}

export function setLineDiscount(state: CartState, index: number, discount: LineDiscount | null): CartState {
  const next = clone(state);
  if (next.lines[index]) next.lines[index].discount = discount;
  return next;
}

export function setLineNote(state: CartState, index: number, note: string | null): CartState {
  const next = clone(state);
  if (next.lines[index]) next.lines[index].note = note;
  return next;
}

export function setOrderDiscount(state: CartState, discount: LineDiscount | null): CartState {
  const next = clone(state);
  next.orderDiscount = discount;
  return next;
}

export function totalQuantity(state: CartState): number {
  return state.lines.reduce((a, l) => a + l.quantity, 0);
}

export function isEmpty(state: CartState): boolean {
  return state.lines.filter((l) => l.quantity > 0).length === 0;
}

/** Convert cart → API items + adjustments (line_no = position + 1). */
export function toApiPayload(state: CartState): { items: CartItemInput[]; adjustments: AdjustmentInput[] } {
  const active = state.lines.filter((l) => l.quantity > 0);
  const items: CartItemInput[] = active.map((l) =>
    l.productId
      ? { productId: l.productId, quantity: l.quantity, note: l.note ?? undefined }
      : { name: l.name, unitPrice: l.unitPrice, unitCode: l.unitCode, quantity: l.quantity, note: l.note ?? undefined },
  );
  const adjustments: AdjustmentInput[] = [];
  active.forEach((l, i) => {
    if (l.discount) {
      adjustments.push({ scope: "line", kind: l.discount.kind, rate: l.discount.rate, amount: l.discount.amount, lineNo: i + 1, reasonCode: l.discount.reasonCode, note: l.discount.note });
    }
  });
  if (state.orderDiscount) {
    adjustments.push({ scope: "order", kind: state.orderDiscount.kind, rate: state.orderDiscount.rate, amount: state.orderDiscount.amount, reasonCode: state.orderDiscount.reasonCode, note: state.orderDiscount.note });
  }
  return { items, adjustments };
}

/** Instant local estimate (pre-server-preview). Not authoritative. */
export function localEstimate(state: CartState): number {
  let subtotal = 0;
  let discount = 0;
  for (const l of state.lines) {
    if (l.quantity <= 0) continue;
    const gross = Math.round(l.unitPrice * l.quantity);
    subtotal += gross;
    if (l.discount) {
      discount += l.discount.kind === "percent"
        ? Math.round((gross * Math.min(100, l.discount.rate ?? 0)) / 100)
        : Math.min(gross, l.discount.amount ?? 0);
    }
  }
  const base = subtotal - discount;
  if (state.orderDiscount) {
    discount += state.orderDiscount.kind === "percent"
      ? Math.round((base * Math.min(100, state.orderDiscount.rate ?? 0)) / 100)
      : Math.min(base, state.orderDiscount.amount ?? 0);
  }
  return Math.max(0, subtotal - discount);
}
