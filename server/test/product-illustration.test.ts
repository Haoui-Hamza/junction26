import { describe, expect, it } from "vitest";
import { productIllustration } from "../../web/src/product-illustration.js";

describe("catalog product illustrations", () => {
  it("uses the supplied illustrations for matching products", () => {
    expect(productIllustration({ category: "milk", name: "Whole milk", attributes: {} })).toBe("/products/whole-milk.jpg");
    expect(productIllustration({ category: "milk", name: "Lactose-free milk", attributes: { lactose_free: true } })).toBe("/products/lactose-free-milk.jpg");
    expect(productIllustration({ category: "plant_milk", name: "Oat drink", attributes: { vegan: true } })).toBe("/products/oat-milk.jpg");
  });

  it("does not imply unrelated products are oat, whole or lactose-free milk", () => {
    expect(productIllustration({ category: "plant_milk", name: "Soy drink", attributes: { vegan: true } })).toBeNull();
    expect(productIllustration({ category: "milk", name: "Semi-skimmed milk", attributes: {} })).toBeNull();
    expect(productIllustration({ category: "milk", name: "Whole milk lactose-free", attributes: { lactose_free: true } })).toBe("/products/lactose-free-milk.jpg");
  });
});
