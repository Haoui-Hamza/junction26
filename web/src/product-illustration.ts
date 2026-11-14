import type { CatalogProduct } from "./api";

export function productIllustration(product: Pick<CatalogProduct, "category" | "name" | "attributes">): string | null {
  if (product.category === "plant_milk") {
    return /\b(oat|oats)\b|kaura/i.test(product.name) ? "/products/oat-milk.jpg" : null;
  }
  if (product.category !== "milk") return null;
  if (product.attributes?.lactose_free === true) return "/products/lactose-free-milk.jpg";
  if (/\bwhole milk\b|täysmaito/i.test(product.name)) return "/products/whole-milk.jpg";
  return null;
}
