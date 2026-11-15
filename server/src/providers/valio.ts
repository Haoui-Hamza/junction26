import { readFileSync } from "node:fs";
import type { Attribute, Offer, PurchaseRequest } from "../domain/types.js";
import { sha256 } from "../domain/util.js";
import { ProviderNotSupportedError, ProviderTimeoutError, type Provider, type SubmitOrderInput } from "./provider.js";

/**
 * Adapter for the Valio Aimo Junction 2026 mock API (https://junction26.valioaimo.fi/openapi.json, v0.1.0).
 *
 * Documented contract (confirmed from the OpenAPI document):
 *   POST /api/price         {customer, requestedDate, products[1..1000]} -> catalogPrice.value per sales unit (EUR, ex VAT)
 *   POST /api/availability  {customer, requestedDate, products[1..1000]} -> scheduleLines[0].{availableAmount, availableDate}, salesBlock
 *   Terminal-product amounts are placeholders (actual quantity unknown) and must not be presented as confirmed stock.
 *   Auth: X-API-Key header. Undisclosed rate limits; do not query the whole catalog.
 * Static product facts (category, names, claims, pack sizes) come from the downloadable product data file.
 * There is NO order-creation endpoint, so submission is unsupported in this adapter.
 */

const CATEGORY_CODES: Record<string, string[]> = {
  milk: ["10400"], // milk & milk drinks in the synthetic catalog
  plant_milk: ["10402"], // plant-based milk alternatives
};

interface StaticProduct {
  id: string;
  name: string;
  category: string;
  salesUnit: string;
  attributes: Partial<Record<Attribute, boolean | null>>;
  evidence: Partial<Record<Attribute, string>>;
  packVolumeMl: number | null;
  packVolumeEvidence?: string;
  packWeightG: number | null;
}

function volumeToMl(v: { unit: string; value: number } | undefined): number | null {
  if (!v) return null;
  const f: Record<string, number> = { LTR: 1000, MLT: 1, DLT: 100, CLT: 10 };
  return f[v.unit] ? Math.round(v.value * f[v.unit]) : null;
}

function nameVolumeMl(name: string): number | null {
  const m = name.match(/(\d+(?:[.,]\d+)?)\s*(l|dl|cl|ml)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  const f: Record<string, number> = { l: 1000, dl: 100, cl: 10, ml: 1 };
  return Math.round(n * f[m[2].toLowerCase()]);
}

function toStatic(p: any, category: string): StaticProduct {
  const s = p.synkkaData ?? {};
  const names: Array<{ value: string; language: string }> = s.names ?? [];
  const name = names.find((n) => n.language === "en")?.value ?? names.find((n) => n.language === "fi")?.value ?? p.id;
  const allNames = names.map((n) => n.value.toLowerCase()).join(" | ");
  const cls: any[] = s.classifications ?? [];
  const claims: string[] = (cls.find((c) => c.name === "nutritionalClaim")?.values ?? []).map((v: any) => v.id);
  const labels: string[] = (cls.find((c) => c.name === "packagingMarkedLabel")?.values ?? []).map((v: any) => v.id);
  const lacs = (cls.find((c) => c.name === "nutritionFact")?.values ?? []).find((v: any) => v.id === "LACS");

  const attributes: StaticProduct["attributes"] = {};
  const evidence: StaticProduct["evidence"] = {};
  if (claims.includes("FREE_FROM_LACTOSE")) {
    attributes.lactose_free = true;
    evidence.lactose_free = "Nutritional claim FREE_FROM_LACTOSE";
  } else if (/laktoositon|lactose[ -]free/.test(allNames)) {
    attributes.lactose_free = true;
    evidence.lactose_free = "Product name says lactose-free";
  } else if (lacs && lacs.value > 0.1) {
    attributes.lactose_free = false;
    evidence.lactose_free = `Lactose ${lacs.value} g per 100 ml`;
  }
  if (claims.includes("VEGAN")) {
    attributes.vegan = true;
    evidence.vegan = "Nutritional claim VEGAN";
  }
  if (labels.some((l) => /ORGANIC/.test(l)) || /luomu|organic/.test(allNames)) {
    attributes.organic = true;
    evidence.organic = labels.find((l) => /ORGANIC/.test(l)) ?? "Product name says organic";
  }

  // Pack volume per sales unit = (sales unit size in base units) x (base unit volume).
  const units: Array<{ unitId: string; sizeInBaseUnits: number }> = p.units ?? [];
  const perBase = units.find((u) => u.unitId === p.salesUnit)?.sizeInBaseUnits ?? (p.salesUnit === p.baseUnit ? 1 : null);
  const baseConv = (s.unitConversions ?? []).find((u: any) => u.synkkaPackagingType === "BASE_UNIT_OR_EACH");
  const weight = baseConv?.netWeight;
  const grams = weight?.unit === "KGM" ? weight.value * 1000 : weight?.unit === "GRM" ? weight.value : null;
  const packWeightG = p.salesUnit === "KG" ? 1000 : perBase != null && grams != null ? Math.round(perBase * grams) : null;
  let baseMl = volumeToMl(baseConv?.volume);
  let packVolumeEvidence = "GS1 base-unit volume × sales-unit size";
  if (baseMl == null) {
    baseMl = nameVolumeMl(name);
    packVolumeEvidence = "Base-unit volume parsed from product name × sales-unit size";
  }
  const packVolumeMl = perBase != null && baseMl != null ? Math.round(perBase * baseMl) : null;
  return { id: p.id, name, category, salesUnit: p.salesUnit, attributes, evidence, packVolumeMl, packVolumeEvidence, packWeightG };
}

export interface ValioConfig {
  baseUrl: string;
  apiKey: string | undefined;
  productDataPath: string;
  customer?: string;
  timeoutMs?: number;
}

export class ValioProvider implements Provider {
  info = {
    id: "valio" as const,
    label: "Valio Aimo mock API",
    orderMode: "unavailable" as const,
    description: "Live price & availability from the Junction 2026 mock API; static product facts from the downloaded catalog file.",
    capabilities: { catalogSearch: true, revalidation: true, submitOrders: false, conditionalSubmit: false, idempotentSubmit: false, orderLookup: false },
    gaps: [
      "The documented API has no order-creation endpoint, so orders cannot be submitted (submission fails with SUBMISSION_UNSUPPORTED).",
      "No conditional submission or idempotency key exists; a gap would remain between revalidation and order creation.",
      "No order lookup endpoint, so an unknown submission outcome cannot be reconciled through the provider.",
      "Rate limits are undisclosed; only pre-filtered SKUs (≤1000 per call) are queried.",
    ],
  };
  private catalog: StaticProduct[] | null = null;
  private ingredientCatalog: StaticProduct[] | null = null;

  constructor(private cfg: ValioConfig) {}

  private loadCatalog(): StaticProduct[] {
    if (this.catalog) return this.catalog;
    const raw = JSON.parse(readFileSync(this.cfg.productDataPath, "utf8")) as any[];
    const out: StaticProduct[] = [];
    for (const p of raw) {
      if (p.deleted) continue;
      for (const [cat, codes] of Object.entries(CATEGORY_CODES)) if (codes.includes(p.category)) out.push(toStatic(p, cat));
    }
    this.catalog = out;
    return out;
  }

  private loadIngredientCatalog(): StaticProduct[] {
      if (this.ingredientCatalog) return this.ingredientCatalog;
      const raw = JSON.parse(readFileSync(this.cfg.productDataPath, "utf8")) as any[];
      this.ingredientCatalog = raw.filter((p) => !p.deleted).map((p) => toStatic(p, p.category));
      return this.ingredientCatalog!;
    }

    async searchIngredients(query: string, requestedDate: string) {
      const words = query.toLowerCase().match(/[a-zåäö0-9]+/g) ?? [];
      if (!words.length) return [];
      const matches = this.loadIngredientCatalog().filter((p) => {
        const name = p.name.toLowerCase();
        return words.every((word) => name.includes(word));
      }).slice(0, 100);
      const quoted = await this.quote(matches, requestedDate);
      return quoted.map((offer, index) => ({ ...offer, packWeightG: matches[index].packWeightG }));
    }

    async quoteIngredients(skus: string[], requestedDate: string) {
      const set = new Set(skus);
      const matches = this.loadIngredientCatalog().filter((p) => set.has(p.id));
      const quoted = await this.quote(matches, requestedDate);
      return quoted.map((offer, index) => ({ ...offer, packWeightG: matches[index].packWeightG }));
  }

  private async post(path: string, body: unknown): Promise<any> {
    if (!this.cfg.apiKey) throw new Error("AIMO_API_KEY is not configured");
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method: "POST",
        headers: { "X-API-Key": this.cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
    } catch (e: any) {
      if (e?.name === "TimeoutError") throw new ProviderTimeoutError(`Valio API ${path} timed out`);
      throw e;
    }
    if (!res.ok) throw new Error(`Valio API ${path} returned HTTP ${res.status}`);
    return res.json();
  }

  private async quote(products: StaticProduct[], requestedDate: string): Promise<Offer[]> {
    const offers: Offer[] = [];
    for (let i = 0; i < products.length; i += 1000) {
      const batch = products.slice(i, i + 1000);
      const body = { customer: this.cfg.customer ?? "junction-demo", requestedDate, products: batch.map((p) => p.id) };
      const [price, avail] = await Promise.all([this.post("/price", body), this.post("/availability", body)]);
      const priceBy = new Map<string, any>((price.products ?? []).map((p: any) => [String(p.productId), p]));
      const availBy = new Map<string, any>((avail.products ?? []).map((p: any) => [String(p.productId), p]));
      for (const p of batch) {
        const pr = priceBy.get(p.id);
        const av = availBy.get(p.id);
        const line = av?.scheduleLines?.[0];
        const priceCents = pr && !pr.error && pr.catalogPrice ? Math.round(pr.catalogPrice.value * 100) : null;
        const terminal = av?.logisticModel && /terminal/i.test(av.logisticModel);
        const deliveryDate = line && line.availableAmount > 0 ? String(line.availableDate).slice(0, 10) : null;
        offers.push({
          sku: p.id,
          name: p.name,
          category: p.category,
          attributes: p.attributes,
          evidence: p.evidence,
          packVolumeMl: p.packVolumeMl,
          packVolumeEvidence: p.packVolumeEvidence,
          priceCents,
          currency: "EUR",
          availablePacks: line ? Math.floor(line.availableAmount) : 0,
          stockKnown: !terminal,
          deliveryDate,
          closingTime: av?.closingTime ?? null,
          salesBlock: !!(av?.salesBlock || line?.salesBlock),
          offerVersion: sha256(`${p.id}|${priceCents}|${deliveryDate}`).slice(0, 12),
        });
      }
    }
    return offers;
  }

  async searchOffers(req: PurchaseRequest): Promise<Offer[]> {
    const all = this.loadCatalog().filter((p) => p.category === req.category);
    // Only query live price/availability for products that pass the static requirements.
    const candidates = all.filter((p) => req.requiredAttributes.every((a) => p.attributes[a] === true) && p.packVolumeMl && (!req.requestedSku || p.id === req.requestedSku));
    const quoted = await this.quote(candidates.slice(0, 1000), req.latestDeliveryDate);
    const quotedIds = new Set(quoted.map((o) => o.sku));
    const unquoted: Offer[] = all
      .filter((p) => !quotedIds.has(p.id))
      .map((p) => ({
        sku: p.id,
        name: p.name,
        category: p.category,
        attributes: p.attributes,
        evidence: p.evidence,
        packVolumeMl: p.packVolumeMl,
        packVolumeEvidence: p.packVolumeEvidence,
        priceCents: null,
        currency: "EUR",
        availablePacks: 0,
        stockKnown: false,
        deliveryDate: null,
        closingTime: null,
        salesBlock: false,
        offerVersion: "not-quoted",
        notQuoted: true,
      }));
    return [...quoted, ...unquoted];
  }

  async quoteOffers(skus: string[], requestedDeliveryDate: string): Promise<Offer[]> {
    const set = new Set(skus);
    return this.quote(this.loadCatalog().filter((p) => set.has(p.id)), requestedDeliveryDate);
  }

  async submitOrder(_input: SubmitOrderInput): Promise<{ providerOrderId: string }> {
    throw new ProviderNotSupportedError("The Valio Aimo mock API documents no order-creation endpoint; submission is not available with this provider.");
  }

  async findOrderBySubmissionKey(): Promise<{ providerOrderId: string } | null> {
    throw new ProviderNotSupportedError("The Valio Aimo mock API has no order lookup endpoint.");
  }
}
