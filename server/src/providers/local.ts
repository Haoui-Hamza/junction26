import { nextCounter, type DB } from "../db.js";
import type { Offer, PurchaseRequest, ReasonCode } from "../domain/types.js";
import type { Clock } from "../domain/util.js";
import { formatEur, helsinkiDate } from "../domain/util.js";
import { OfferChangedError, ProviderTimeoutError, type Provider, type SubmitOrderInput } from "./provider.js";

export interface SeedOffer {
  sku: string;
  name: string;
  category: string;
  attributes: Record<string, boolean | null>;
  evidence: Record<string, string>;
  packVolumeMl: number | null;
  priceCents: number | null;
  availablePacks: number;
  deliveryDate: string | null;
  closingTime: string | null;
  salesBlock?: boolean;
}

/** Seeded sample catalog. Deadline is Monday 2026-11-16 (fixed clock: Friday 2026-11-13 09:00 Helsinki). */
export const DEMO_SEED: SeedOffer[] = [
  {
    sku: "A",
    name: "Lactose-free semi-skimmed milk 10 L bag-in-box",
    category: "milk",
    attributes: { lactose_free: true },
    evidence: { lactose_free: "Nutritional claim FREE_FROM_LACTOSE" },
    packVolumeMl: 10_000,
    priceCents: 1200,
    availablePacks: 60,
    deliveryDate: "2026-11-16",
    closingTime: "2026-11-13T15:00:00+02:00",
  },
  {
    sku: "B",
    name: "Lactose-free milk drink 10 L novobox",
    category: "milk",
    attributes: { lactose_free: true },
    evidence: { lactose_free: "Nutritional claim FREE_FROM_LACTOSE" },
    packVolumeMl: 10_000,
    priceCents: 1300,
    availablePacks: 40,
    deliveryDate: "2026-11-16",
    closingTime: "2026-11-13T15:00:00+02:00",
  },
  {
    sku: "C",
    name: "Lactose-free whole milk 10 L ESL",
    category: "milk",
    attributes: { lactose_free: true },
    evidence: { lactose_free: "Nutritional claim FREE_FROM_LACTOSE" },
    packVolumeMl: 10_000,
    priceCents: 1400,
    availablePacks: 100,
    deliveryDate: "2026-11-16",
    closingTime: "2026-11-13T15:00:00+02:00",
  },
  {
    sku: "D",
    name: "Semi-skimmed milk 10 L bag-in-box (regular)",
    category: "milk",
    attributes: { lactose_free: false },
    evidence: { lactose_free: "Contains lactose (allergen: milk, no lactose-free claim)" },
    packVolumeMl: 10_000,
    priceCents: 950,
    availablePacks: 300,
    deliveryDate: "2026-11-16",
    closingTime: "2026-11-13T15:00:00+02:00",
  },
  {
    sku: "E",
    name: "Lactose-free milk drink 10 L (supplier terminal)",
    category: "milk",
    attributes: { lactose_free: true },
    evidence: { lactose_free: "Nutritional claim FREE_FROM_LACTOSE" },
    packVolumeMl: 10_000,
    priceCents: 1100,
    availablePacks: 200,
    deliveryDate: "2026-11-17",
    closingTime: "2026-11-13T12:00:00+02:00",
  },
  {
    sku: "F",
    name: "Organic farm milk 10 L",
    category: "milk",
    attributes: { lactose_free: null, organic: true },
    evidence: { organic: "Label: EU organic" },
    packVolumeMl: 10_000,
    priceCents: 1150,
    availablePacks: 80,
    deliveryDate: "2026-11-16",
    closingTime: "2026-11-13T15:00:00+02:00",
  },
  {
    sku: "G",
    name: "Oat drink 1 L (plant-based)",
    category: "plant_milk",
    attributes: { vegan: true },
    evidence: { vegan: "Product is identified as plant-based" },
    packVolumeMl: 1000,
    priceCents: 80,
    availablePacks: 2000,
    deliveryDate: "2026-11-16",
    closingTime: "2026-11-13T15:00:00+02:00",
  },
];

export type LocalFault = "none" | "timeout_before_commit" | "timeout_after_commit";

/**
 * Deterministic local provider backed by SQLite. Order creation checks expected price/delivery/stock and the
 * idempotency key inside the same transaction that decrements stock and inserts the order.
 */
export class LocalProvider implements Provider {
  info = {
    id: "local" as const,
    label: "Local seeded provider",
    description: "Deterministic SQLite-backed supplier with the Junction sample catalog (SKUs A–G) and a fixed clock.",
    orderMode: "simulated" as const,
    capabilities: { catalogSearch: true, revalidation: true, submitOrders: true, conditionalSubmit: true, idempotentSubmit: true, orderLookup: true },
    gaps: [] as string[],
  };

  constructor(private db: DB, private clock: Clock, private seed: SeedOffer[] = DEMO_SEED) {
    const n = (db.prepare("SELECT COUNT(*) n FROM provider_offers").get() as { n: number }).n;
    if (n === 0) this.reset();
    else this.addMissingSeedOffers(seed);
  }

  private addMissingSeedOffers(seed: SeedOffer[]): void {
    this.db.transaction(() => {
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO provider_offers (sku,name,category,attributes_json,evidence_json,pack_volume_ml,price_cents,available_packs,delivery_date,closing_time,sales_block,version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      );
      for (const s of seed)
        ins.run(s.sku, s.name, s.category, JSON.stringify(s.attributes), JSON.stringify(s.evidence), s.packVolumeMl, s.priceCents, s.availablePacks, s.deliveryDate, s.closingTime, s.salesBlock ? 1 : 0);
    })();
  }

  reset(seed: SeedOffer[] = this.seed): void {
    this.seed = seed;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM provider_offers").run();
      this.db.prepare("DELETE FROM provider_orders").run();
      this.db.prepare("DELETE FROM provider_state").run();
      const ins = this.db.prepare(
        `INSERT INTO provider_offers (sku,name,category,attributes_json,evidence_json,pack_volume_ml,price_cents,available_packs,delivery_date,closing_time,sales_block,version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      );
      for (const s of seed)
        ins.run(s.sku, s.name, s.category, JSON.stringify(s.attributes), JSON.stringify(s.evidence), s.packVolumeMl, s.priceCents, s.availablePacks, s.deliveryDate, s.closingTime, s.salesBlock ? 1 : 0);
    })();
  }

  // ---- normal data path for supplier-side changes (also used by the demo controls) ----
  setPrice(sku: string, priceCents: number): void {
    if (!this.exists(sku)) throw new Error(`Unknown SKU ${sku}`);
    this.db.prepare("UPDATE provider_offers SET price_cents=?, version=version+1 WHERE sku=? AND price_cents IS NOT ?").run(priceCents, sku, priceCents);
  }
  setStock(sku: string, packs: number): void {
    if (!this.exists(sku)) throw new Error(`Unknown SKU ${sku}`);
    this.db.prepare("UPDATE provider_offers SET available_packs=? WHERE sku=?").run(packs, sku);
  }
  setDeliveryDate(sku: string, date: string): void {
    if (!this.exists(sku)) throw new Error(`Unknown SKU ${sku}`);
    this.db.prepare("UPDATE provider_offers SET delivery_date=?, version=version+1 WHERE sku=? AND delivery_date IS NOT ?").run(date, sku, date);
  }
  setFault(fault: LocalFault): void {
    this.db.prepare("INSERT INTO provider_state(key,value) VALUES('fault',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(fault);
  }
  getFault(): LocalFault {
    return ((this.db.prepare("SELECT value FROM provider_state WHERE key='fault'").get() as { value: string } | undefined)?.value ?? "none") as LocalFault;
  }
  listOffers(): Offer[] {
    return (this.db.prepare("SELECT * FROM provider_offers ORDER BY sku").all() as Row[]).map(rowToOffer);
  }
  listOrders(): Array<{ id: string; submissionKey: string; totalCents: number; createdAt: string; lines: unknown }> {
    return (this.db.prepare("SELECT * FROM provider_orders ORDER BY created_at, id").all() as any[]).map((r) => ({
      id: r.id,
      submissionKey: r.submission_key,
      totalCents: r.total_cents,
      createdAt: r.created_at,
      lines: JSON.parse(r.lines_json),
    }));
  }
  private exists(sku: string) {
    return !!this.db.prepare("SELECT 1 FROM provider_offers WHERE sku=?").get(sku);
  }

  // ---- Provider interface ----
  async searchOffers(req: PurchaseRequest): Promise<Offer[]> {
    const rows = this.db.prepare("SELECT * FROM provider_offers WHERE category=? ORDER BY sku").all(req.category) as Row[];
    return rows.map(rowToOffer);
  }

  async quoteOffers(skus: string[]): Promise<Offer[]> {
    if (!skus.length) return [];
    const rows = this.db.prepare(`SELECT * FROM provider_offers WHERE sku IN (${skus.map(() => "?").join(",")}) ORDER BY sku`).all(...skus) as Row[];
    return rows.map(rowToOffer);
  }

  async submitOrder(input: SubmitOrderInput): Promise<{ providerOrderId: string }> {
    const fault = this.getFault();
    if (fault === "timeout_before_commit") {
      this.setFault("none");
      throw new ProviderTimeoutError("Local provider timed out before creating the order (injected fault)");
    }
    const create = this.db.transaction((): { providerOrderId: string; replay: boolean } => {
      const existing = this.db.prepare("SELECT id FROM provider_orders WHERE submission_key=?").get(input.submissionKey) as { id: string } | undefined;
      if (existing) return { providerOrderId: existing.id, replay: true };
      const problems: ReasonCode[] = [];
      for (const l of input.lines) {
        const r = this.db.prepare("SELECT * FROM provider_offers WHERE sku=?").get(l.sku) as Row | undefined;
        if (!r) problems.push({ code: "SKU_UNAVAILABLE", message: `SKU ${l.sku} not found` });
        else {
          if (r.sales_block) problems.push({ code: "SALES_BLOCKED", message: `SKU ${l.sku} is blocked` });
          if (r.price_cents !== l.expectedUnitPriceCents)
            problems.push({ code: "PRICE_CHANGED", message: `SKU ${l.sku} price is ${formatEur(r.price_cents ?? 0)}, expected ${formatEur(l.expectedUnitPriceCents)}` });
          if (r.delivery_date !== l.expectedDeliveryDate) problems.push({ code: "DELIVERY_CHANGED", message: `SKU ${l.sku} delivery is ${r.delivery_date}, expected ${l.expectedDeliveryDate}` });
          if (r.available_packs < l.packs) problems.push({ code: "STOCK_INSUFFICIENT", message: `SKU ${l.sku} has ${r.available_packs} packs, order needs ${l.packs}` });
        }
      }
      const total = input.lines.reduce((s, l) => s + l.packs * l.expectedUnitPriceCents, 0);
      if (total !== input.expectedTotalCents) problems.push({ code: "TOTAL_MISMATCH", message: "Expected total does not match the lines" });
      if (problems.length) throw new OfferChangedError(problems);
      for (const l of input.lines) this.db.prepare("UPDATE provider_offers SET available_packs = available_packs - ? WHERE sku=?").run(l.packs, l.sku);
      const seq = nextCounter(this.db, "provider_order");
      const id = `VA-${helsinkiDate(this.clock.now()).replaceAll("-", "")}-${String(seq).padStart(4, "0")}`;
      this.db
        .prepare("INSERT INTO provider_orders (id, submission_key, lines_json, total_cents, created_at) VALUES (?,?,?,?,?)")
        .run(id, input.submissionKey, JSON.stringify(input.lines), total, this.clock.now().toISOString());
      return { providerOrderId: id, replay: false };
    });
    const res = create();
    if (fault === "timeout_after_commit" && !res.replay) {
      this.setFault("none");
      throw new ProviderTimeoutError("Local provider timed out after the order was created (injected fault)");
    }
    return { providerOrderId: res.providerOrderId };
  }

  async findOrderBySubmissionKey(submissionKey: string) {
    const r = this.db.prepare("SELECT id FROM provider_orders WHERE submission_key=?").get(submissionKey) as { id: string } | undefined;
    return r ? { providerOrderId: r.id } : null;
  }
}

interface Row {
  sku: string;
  name: string;
  category: string;
  attributes_json: string;
  evidence_json: string;
  pack_volume_ml: number | null;
  price_cents: number | null;
  available_packs: number;
  delivery_date: string | null;
  closing_time: string | null;
  sales_block: number;
  version: number;
}

function rowToOffer(r: Row): Offer {
  return {
    sku: r.sku,
    name: r.name,
    category: r.category,
    attributes: JSON.parse(r.attributes_json),
    evidence: JSON.parse(r.evidence_json),
    packVolumeMl: r.pack_volume_ml,
    packVolumeEvidence: "Seeded catalog",
    priceCents: r.price_cents,
    currency: "EUR",
    availablePacks: r.available_packs,
    stockKnown: true,
    deliveryDate: r.delivery_date,
    closingTime: r.closing_time,
    salesBlock: !!r.sales_block,
    offerVersion: `${r.sku}-v${r.version}`,
  };
}
