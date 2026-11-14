import { describe, expect, it } from "vitest";
import { bestSingleSku, compareOffers, compareOptions, evaluateEligibility, searchFills } from "../src/domain/compare.js";
import { offer, req } from "./helpers.js";

const skus = (o: { lines: Array<{ sku: string; packs: number }> } | null) => o?.lines.map((l) => `${l.sku}x${l.packs}`).join("+");

describe("exact whole-pack allocation", () => {
  it("finds the demo combination A×60 + B×40 = €1,240 and the single-SKU C = €1,400", () => {
    const offers = [offer("A", 10, 1200, 60), offer("B", 10, 1300, 40), offer("C", 10, 1400, 100)];
    const c = compareOffers(req(1000), offers);
    expect(skus(c.single)).toBe("Cx100");
    expect(c.single!.totalCents).toBe(140000);
    expect(skus(c.combined)).toBe("Ax60+Bx40");
    expect(c.combined!.totalCents).toBe(124000);
    expect(c.combined!.volumeMl).toBe(1_000_000);
    expect(c.savingsCents).toBe(16000);
    expect(c.recommendedKind).toBe("combined");
    expect(c.contributions.map((x) => [x.sku, x.volumeMl])).toEqual([["A", 600_000], ["B", 400_000]]);
  });

  it("finds an exact fill that cheapest-unit-price-first greedy misses", () => {
    // Need 12 L. X is cheapest per litre (5 L for €4 = €0.80/L). Greedy takes X×2 = 10 L and cannot fill the last 2 L.
    // The only exact fill is Y×3 (4 L packs).
    const offers = [offer("X", 5, 400, 10), offer("Y", 4, 400, 3)];
    const fills = searchFills(req(12), offers);
    expect(skus(fills.exact)).toBe("Yx3");
    expect(fills.exact!.totalCents).toBe(1200);
  });

  it("finds a cheaper mixed fill that greedy would miss", () => {
    // Need 20 L. Greedy (cheapest per litre first): P 6 L @ €5.40 (€0.90/L) ×3 = 18 L, remainder 2 L → Q 2 L @ €3 = €19.20.
    // Optimal: R 5 L @ €4.60 (€0.92/L) ×4 = €18.40.
    const offers = [offer("P", 6, 540, 3), offer("Q", 2, 300, 10), offer("R", 5, 460, 4)];
    const c = compareOffers(req(20), offers);
    expect(c.combined!.totalCents).toBe(1840);
    expect(skus(c.combined)).toBe("Rx4");
  });

  it("respects stock as a hard limit on packs", () => {
    const offers = [offer("A", 10, 1000, 3), offer("B", 10, 2000, 100)];
    const c = compareOffers(req(50), offers);
    expect(skus(c.combined)).toBe("Ax3+Bx2");
    expect(skus(c.single)).toBe("Bx5");
  });

  it("uses millilitre packs correctly (no float drift)", () => {
    const offers = [offer("S", 0.2, 45, 1000), offer("T", 1, 210, 2)];
    const c = compareOffers(req(2.4), offers);
    expect(c.combined!.volumeMl).toBe(2400);
    expect(Number.isInteger(c.combined!.totalCents)).toBe(true);
  });
});

describe("ranking", () => {
  it("ranks by total cost first", () => {
    const offers = [offer("A", 10, 1000, 10), offer("B", 10, 999, 10)];
    expect(bestSingleSku(req(100), offers)!.lines[0].sku).toBe("B");
  });

  it("breaks cost ties by the latest delivery date (earlier wins)", () => {
    const offers = [offer("A", 10, 1000, 10, { deliveryDate: "2026-11-16" }), offer("B", 10, 1000, 10, { deliveryDate: "2026-11-14" })];
    expect(bestSingleSku(req(100), offers)!.lines[0].sku).toBe("B");
  });

  it("breaks cost and date ties by fewer lines, then stable SKU order", () => {
    const offers = [offer("C", 10, 1000, 10), offer("A", 10, 1000, 5), offer("B", 10, 1000, 10)];
    const c = compareOffers(req(100), offers);
    expect(c.combined!.lines.length).toBe(1);
    expect(skus(c.combined)).toBe("Bx10"); // A cannot cover alone; B before C
    const a = { totalCents: 1, latestDeliveryDate: "2026-11-16", lines: [{ sku: "B" }, { sku: "C" }] } as any;
    const b = { totalCents: 1, latestDeliveryDate: "2026-11-16", lines: [{ sku: "A" }, { sku: "D" }] } as any;
    expect(compareOptions(b, a)).toBeLessThan(0);
  });
});

describe("eligibility", () => {
  it("excludes late, incompatible, unknown-evidence, blocked and unpriced stock with reasons", () => {
    const offers = [
      offer("OK", 10, 1000, 10),
      offer("LATE", 10, 500, 100, { deliveryDate: "2026-11-17" }),
      offer("REG", 10, 400, 100, { attributes: { lactose_free: false } }),
      offer("UNK", 10, 450, 100, { attributes: {} }),
      offer("BLK", 10, 450, 100, { salesBlock: true }),
      offer("NOP", 10, 450, 100, { priceCents: null }),
      offer("NOD", 10, 450, 100, { deliveryDate: null }),
    ];
    const { eligible, excluded } = evaluateEligibility(req(100), offers);
    expect(eligible.map((o) => o.sku)).toEqual(["OK"]);
    const code = (sku: string) => excluded.find((e) => e.sku === sku)!.reasons.map((r) => r.code);
    expect(code("LATE")).toContain("LATE_DELIVERY");
    expect(code("REG")).toContain("ATTRIBUTE_FAILED");
    expect(code("UNK")).toContain("ATTRIBUTE_UNKNOWN");
    expect(code("BLK")).toContain("SALES_BLOCKED");
    expect(code("NOP")).toContain("NO_PRICE");
    expect(code("NOD")).toContain("NO_DELIVERY");
    // Cheaper ineligible stock never appears in the options.
    const c = compareOffers(req(100), offers);
    expect(skus(c.recommended)).toBe("OKx10");
  });

  it("does not substitute an explicitly requested SKU", () => {
    const offers = [offer("A", 10, 1000, 100), offer("B", 10, 900, 100)];
    const c = compareOffers(req(100, { requestedSku: "A" }), offers);
    expect(skus(c.recommended)).toBe("Ax10");
    expect(c.excluded.find((e) => e.sku === "B")!.reasons[0].code).toBe("NOT_REQUESTED_SKU");
  });
});

describe("inability to fulfil", () => {
  it("explains insufficient stock and offers a non-submittable partial option", () => {
    const offers = [offer("A", 10, 1200, 30), offer("B", 10, 1300, 20)];
    const c = compareOffers(req(1000), offers);
    expect(c.recommended).toBeNull();
    expect(c.noFill!.code).toBe("INSUFFICIENT_STOCK");
    const partial = c.partialOptions.find((p) => p.kind === "partial_shortfall")!;
    expect(partial.volumeMl).toBe(500_000);
    expect(partial.submittable).toBe(false);
  });

  it("explains a pack-size mismatch with shortfall and excess options", () => {
    const offers = [offer("A", 6, 600, 100)];
    const c = compareOffers(req(20), offers);
    expect(c.noFill!.code).toBe("PACK_SIZE_MISMATCH");
    expect(c.partialOptions.map((p) => [p.kind, p.volumeMl])).toEqual([["partial_shortfall", 18000], ["partial_excess", 24000]]);
    expect(c.partialOptions.every((p) => !p.submittable)).toBe(true);
  });

  it("reports no eligible offer when everything is excluded", () => {
    const c = compareOffers(req(100), [offer("REG", 10, 400, 100, { attributes: { lactose_free: false } })]);
    expect(c.noFill!.code).toBe("NO_ELIGIBLE_OFFER");
  });
});

describe("bounded allocation", () => {
  it("limits work on large catalogs without claiming the search was exhaustive", () => {
    const offers = Array.from({ length: 200 }, (_, index) =>
      offer(`S${String(index).padStart(3, "0")}`, 0.1, 10 + index, 1000),
    );
    const started = performance.now();
    const c = compareOffers(req(100), offers);

    expect(performance.now() - started).toBeLessThan(5000);
    expect(c.searchBounded).toBe(true);
    expect(c.recommended?.volumeMl).toBe(100_000);
    expect(c.notes.join(" ")).toMatch(/lowest possible price cannot be guaranteed/);
    expect(c.notes.join(" ")).not.toMatch(/cheapest exact fill/);
  });

  it("does not claim a pack-size mismatch when an exact search cannot complete", () => {
    const c = compareOffers(req(500), [offer("A", 3, 300, 200), offer("B", 3.001, 400, 200)]);

    expect(c.searchBounded).toBe(true);
    expect(c.recommended).toBeNull();
    expect(c.noFill?.code).toBe("SEARCH_LIMIT_REACHED");
    expect(c.noFill?.message).toMatch(/search limit/);
  });
});
