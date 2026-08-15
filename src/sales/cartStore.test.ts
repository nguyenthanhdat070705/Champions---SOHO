import { describe, it, expect } from "vitest";
import {
  emptyCart, addProduct, incLine, decLine, removeLine, setLineDiscount,
  setOrderDiscount, toApiPayload, localEstimate, totalQuantity, isEmpty,
} from "./cartStore";
import type { ApiProduct } from "../lib/api";

const water: ApiProduct = { id: "w", name: "Nước", sku: null, barcode: null, unitCode: "chai", salePrice: 10000, trackInventory: true, allowDiscount: true, isActive: true, categoryId: null, onHand: 5, lowStockThreshold: 2 };
const cake: ApiProduct = { ...water, id: "c", name: "Bánh", salePrice: 15000, onHand: 3 };

describe("cartStore", () => {
  it("adds products and stacks quantity", () => {
    let s = emptyCart();
    s = addProduct(s, water);
    s = addProduct(s, water);
    s = addProduct(s, cake);
    expect(s.lines.length).toBe(2);
    expect(s.lines[0].quantity).toBe(2);
    expect(totalQuantity(s)).toBe(3);
  });

  it("inc/dec/remove lines", () => {
    let s = addProduct(emptyCart(), water);
    s = incLine(s, 0);
    expect(s.lines[0].quantity).toBe(2);
    s = decLine(s, 0);
    expect(s.lines[0].quantity).toBe(1);
    s = removeLine(s, 0);
    expect(isEmpty(s)).toBe(true);
  });

  it("localEstimate matches server pricing rules (line + order discount)", () => {
    let s = addProduct(emptyCart(), water); // 10000
    s = incLine(s, 0); // 2 × 10000 = 20000
    s = setLineDiscount(s, 0, { kind: "percent", rate: 10 }); // -2000 → 18000
    expect(localEstimate(s)).toBe(18000);
    s = addProduct(s, cake); // +15000 → subtotal 35000, line disc 2000 → 33000
    s = setOrderDiscount(s, { kind: "fixed", amount: 3000 }); // -3000 → 30000
    expect(localEstimate(s)).toBe(30000);
  });

  it("toApiPayload maps line_no by position and includes adjustments", () => {
    let s = addProduct(emptyCart(), water);
    s = addProduct(s, cake);
    s = setLineDiscount(s, 1, { kind: "fixed", amount: 1000, reasonCode: "DAMAGED" });
    s = setOrderDiscount(s, { kind: "percent", rate: 5, reasonCode: "LOYAL" });
    const { items, adjustments } = toApiPayload(s);
    expect(items.map((i) => i.productId)).toEqual(["w", "c"]);
    expect(adjustments).toContainEqual(expect.objectContaining({ scope: "line", lineNo: 2, kind: "fixed", amount: 1000 }));
    expect(adjustments).toContainEqual(expect.objectContaining({ scope: "order", kind: "percent", rate: 5 }));
  });

  it("estimate never goes negative", () => {
    let s = addProduct(emptyCart(), water);
    s = setLineDiscount(s, 0, { kind: "fixed", amount: 99999 });
    expect(localEstimate(s)).toBe(0);
  });
});
