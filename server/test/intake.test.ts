import { describe, expect, it } from "vitest";
import { parseRequestRules, resolveDeadline } from "../src/domain/intake.js";

const FRIDAY = new Date("2026-11-13T09:00:00+02:00");

describe("intake", () => {
  it("extracts the demo request with Helsinki date resolution", () => {
    const r = parseRequestRules("Get 1,000 litres of lactose-free milk delivered by Monday. Keep it under €1,200 if possible.", FRIDAY);
    expect(r.complete).toBe(true);
    expect(r.draft).toMatchObject({ category: "milk", requiredAttributes: ["lactose_free"], quantity: 1000, unit: "L", latestDeliveryDate: "2026-11-16", preferredBudgetCents: 120000, budgetIsLimit: false });
    expect(r.question).toBeNull();
  });

  it("recognizes vegan milk and a strict budget limit", () => {
    const r = parseRequestRules("Order 1,100 litres of vegan milk by Monday. Our budget limit is €900.", FRIDAY);
    expect(r.draft).toMatchObject({
      category: "plant_milk",
      requiredAttributes: ["vegan"],
      quantity: 1100,
      preferredBudgetCents: 90000,
      budgetIsLimit: true,
    });
  });

  it("treats 'within the budget of' as a hard budget despite a typo in 'within'", () => {
    const r = parseRequestRules("1000 liters of vegan milk by Wednesday, withn the budget of 600 euro", FRIDAY);
    expect(r.draft).toMatchObject({
      category: "plant_milk",
      requiredAttributes: ["vegan"],
      quantity: 1000,
      latestDeliveryDate: "2026-11-18",
      preferredBudgetCents: 60000,
      budgetIsLimit: true,
    });
    expect(r.complete).toBe(true);
  });

  it("interprets before Tuesday as a Monday delivery deadline", () => {
    const r = parseRequestRules("1000 liters of vegan milk before Tuesday", FRIDAY);
    expect(r.draft).toMatchObject({ category: "plant_milk", requiredAttributes: ["vegan"], latestDeliveryDate: "2026-11-16" });
    expect(r.complete).toBe(true);
  });

  it("treats a soft budget target as a preference", () => {
    const r = parseRequestRules("Get 100 litres of oat milk by Monday, ideally under €900.", FRIDAY);
    expect(r.draft).toMatchObject({ category: "plant_milk", preferredBudgetCents: 90000, budgetIsLimit: false });
  });

  it("resolves relative dates in Europe/Helsinki, not UTC", () => {
    // 23:30 UTC on Friday is already Saturday 01:30 in Helsinki.
    expect(resolveDeadline("by tomorrow", new Date("2026-11-13T23:30:00Z")).date).toBe("2026-11-15");
  });

  it("asks one targeted question when the deadline is missing", () => {
    const r = parseRequestRules("Get 1000 litres of lactose-free milk", FRIDAY);
    expect(r.missing).toEqual(["latestDeliveryDate"]);
    expect(r.question).toMatch(/date/);
  });

  it("asks about an ambiguous weekday that is today", () => {
    const r = parseRequestRules("Get 100 l milk by Friday", FRIDAY);
    expect(r.question).toMatch(/today .* or next week/);
  });

  it("asks for a concrete date for 'before next week'", () => {
    const r = parseRequestRules("Get 100 l milk before next week", FRIDAY);
    expect(r.missing).toContain("latestDeliveryDate");
    expect(r.question).toMatch(/not a specific delivery date/);
  });

  it("asks for the unit when the quantity has none", () => {
    const r = parseRequestRules("Order 1000 cartons of lactose-free milk by Monday", FRIDAY);
    expect(r.missing).toContain("quantity");
    expect(r.question).toMatch(/litres/);
  });
});
