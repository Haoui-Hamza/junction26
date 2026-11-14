import { openDb } from "../src/db.js";
import type { Actor, Offer, PurchaseRequest } from "../src/domain/types.js";
import { makeClock } from "../src/domain/util.js";
import { OrderService } from "../src/orders.js";
import { LocalProvider, DEMO_SEED, type SeedOffer } from "../src/providers/local.js";

export const NOW = "2026-11-13T09:00:00+02:00"; // Friday, Helsinki
export const MONDAY = "2026-11-16";

export function req(litres: number, extra: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    rawText: null,
    category: "milk",
    requiredAttributes: ["lactose_free"],
    quantity: litres,
    unit: "L",
    quantityMl: Math.round(litres * 1000),
    latestDeliveryDate: MONDAY,
    preferredBudgetCents: null,
    budgetIsLimit: false,
    requestedSku: null,
    ...extra,
  };
}

let n = 0;
export function offer(sku: string, packL: number, priceCents: number, packs: number, extra: Partial<Offer> = {}): Offer {
  return {
    sku,
    name: `Test milk ${sku}`,
    category: "milk",
    attributes: { lactose_free: true },
    evidence: { lactose_free: "test" },
    packVolumeMl: Math.round(packL * 1000),
    priceCents,
    currency: "EUR",
    availablePacks: packs,
    stockKnown: true,
    deliveryDate: MONDAY,
    closingTime: null,
    salesBlock: false,
    offerVersion: `${sku}-${n++}`,
    ...extra,
  };
}

export const agent: Actor = { id: "agent:test", name: "Test agent", role: "agent" };
export const approver: Actor = { id: "user:approver", name: "Test approver", role: "approver" };
export const buyer: Actor = { id: "user:buyer", name: "Test buyer", role: "buyer" };

export function setup(seed: SeedOffer[] = DEMO_SEED) {
  const db = openDb(":memory:");
  const clock = makeClock(NOW);
  const provider = new LocalProvider(db, clock, seed);
  const service = new OrderService(db, provider, clock);
  return { db, clock, provider, service };
}

/** Plain request body as an agent would send it (no derived fields). */
export function body(litres: number, extra: Record<string, unknown> = {}) {
  return {
    category: "milk",
    requiredAttributes: ["lactose_free"],
    quantity: litres,
    unit: "L",
    latestDeliveryDate: MONDAY,
    preferredBudgetCents: 120000,
    budgetIsLimit: false,
    ...extra,
  };
}
