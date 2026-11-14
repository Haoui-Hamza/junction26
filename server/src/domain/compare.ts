import type { Offer, OptionLine, OrderOption, PurchaseRequest, ReasonCode } from "./types.js";
import { describeDate, formatEur, formatLitres, gcd } from "./util.js";

export interface ExcludedOffer {
  sku: string;
  name: string;
  reasons: ReasonCode[];
}

export interface Eligibility {
  eligible: Offer[];
  excluded: ExcludedOffer[];
}

const ATTRIBUTE_LABEL: Record<string, string> = { lactose_free: "lactose-free", organic: "organic", vegan: "vegan" };

/** Filters offers against the hard requirements. Missing evidence for a requirement makes an offer ineligible. */
export function evaluateEligibility(req: PurchaseRequest, offers: Offer[]): Eligibility {
  const eligible: Offer[] = [];
  const excluded: ExcludedOffer[] = [];
  for (const o of [...offers].sort((a, b) => a.sku.localeCompare(b.sku))) {
    const reasons: ReasonCode[] = [];
    if (req.requestedSku && o.sku !== req.requestedSku)
      reasons.push({ code: "NOT_REQUESTED_SKU", message: `Buyer explicitly requested SKU ${req.requestedSku}; substitution is not allowed` });
    if (o.category !== req.category)
      reasons.push({ code: "CATEGORY_MISMATCH", message: `Category is ${o.category}, request needs ${req.category}` });
    for (const attr of req.requiredAttributes) {
      const v = o.attributes[attr];
      const label = ATTRIBUTE_LABEL[attr] ?? attr;
      if (v === false) reasons.push({ code: "ATTRIBUTE_FAILED", message: `Not ${label}${o.evidence[attr] ? ` (${o.evidence[attr]})` : ""}` });
      else if (v !== true) reasons.push({ code: "ATTRIBUTE_UNKNOWN", message: `No evidence that it is ${label}; treated as ineligible` });
    }
    if (o.packVolumeMl == null || o.packVolumeMl <= 0)
      reasons.push({ code: "PACK_SIZE_UNKNOWN", message: "Pack volume is not known, so litres cannot be verified" });
    if (o.notQuoted) {
      if (!reasons.length) reasons.push({ code: "NOT_QUOTED", message: "Excluded by static product data; live price and availability not queried" });
      excluded.push({ sku: o.sku, name: o.name, reasons });
      continue;
    }
    if (o.priceCents == null) reasons.push({ code: "NO_PRICE", message: "Provider returned no fixed price" });
    if (o.salesBlock) reasons.push({ code: "SALES_BLOCKED", message: "Product is currently blocked from sale" });
    if (!o.deliveryDate) reasons.push({ code: "NO_DELIVERY", message: "Product cannot currently be delivered on any date" });
    else if (o.deliveryDate > req.latestDeliveryDate)
      reasons.push({
        code: "LATE_DELIVERY",
        message: `Earliest delivery ${describeDate(o.deliveryDate)} is after the deadline ${describeDate(req.latestDeliveryDate)}`,
      });
    if (o.availablePacks <= 0) reasons.push({ code: "NO_STOCK", message: "No packs available" });
    if (reasons.length) excluded.push({ sku: o.sku, name: o.name, reasons });
    else eligible.push(o);
  }
  return { eligible, excluded };
}

// ---------- ranking ----------

export function rankKey(opt: Pick<OrderOption, "totalCents" | "latestDeliveryDate" | "lines">) {
  return {
    total: opt.totalCents,
    date: opt.latestDeliveryDate,
    lines: opt.lines.length,
    sig: opt.lines.map((l) => l.sku).sort().join(","),
  };
}

/** Total cost, then latest delivery date across lines (earlier is better), then fewer lines, then stable SKU order. */
export function compareOptions(a: Pick<OrderOption, "totalCents" | "latestDeliveryDate" | "lines">, b: typeof a): number {
  const ka = rankKey(a);
  const kb = rankKey(b);
  if (ka.total !== kb.total) return ka.total - kb.total;
  if (ka.date !== kb.date) return ka.date < kb.date ? -1 : 1;
  if (ka.lines !== kb.lines) return ka.lines - kb.lines;
  return ka.sig < kb.sig ? -1 : ka.sig > kb.sig ? 1 : 0;
}

function buildOption(kind: OrderOption["kind"], picks: Array<{ offer: Offer; packs: number }>, req: PurchaseRequest): OrderOption {
  const lines: OptionLine[] = picks
    .filter((p) => p.packs > 0)
    .sort((a, b) => a.offer.sku.localeCompare(b.offer.sku))
    .map(({ offer, packs }) => ({
      sku: offer.sku,
      name: offer.name,
      packs,
      packVolumeMl: offer.packVolumeMl!,
      volumeMl: packs * offer.packVolumeMl!,
      unitPriceCents: offer.priceCents!,
      lineTotalCents: packs * offer.priceCents!,
      deliveryDate: offer.deliveryDate!,
    }));
  const totalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const volumeMl = lines.reduce((s, l) => s + l.volumeMl, 0);
  const latestDeliveryDate = lines.reduce((m, l) => (l.deliveryDate > m ? l.deliveryDate : m), "");
  const exact = volumeMl === req.quantityMl;
  const qualifies: string[] = [];
  if (exact) qualifies.push(`Exactly ${formatLitres(req.quantityMl)} in whole packs`);
  else if (volumeMl < req.quantityMl) qualifies.push(`Covers only ${formatLitres(volumeMl)} of ${formatLitres(req.quantityMl)} (shortfall ${formatLitres(req.quantityMl - volumeMl)})`);
  else qualifies.push(`Delivers ${formatLitres(volumeMl)}, ${formatLitres(volumeMl - req.quantityMl)} more than requested`);
  if (req.requiredAttributes.length)
    qualifies.push(`Every line is ${req.requiredAttributes.map((a) => ATTRIBUTE_LABEL[a] ?? a).join(" and ")} (evidence checked per SKU)`);
  qualifies.push(`All lines arrive by ${describeDate(latestDeliveryDate)} (deadline ${describeDate(req.latestDeliveryDate)})`);
  const unknownStock = picks.filter((p) => p.packs > 0 && !p.offer.stockKnown).map((p) => p.offer.sku);
  if (unknownStock.length) {
    qualifies.push(`Supplier quantity is unconfirmed for ${unknownStock.join(", ")}; confirm availability before ordering.`);
  } else {
    qualifies.push("Pack counts are within confirmed stock");
  }
  return { kind, lines, totalCents, volumeMl, currency: "EUR", latestDeliveryDate, qualifies, submittable: exact && kind !== "partial_shortfall" && kind !== "partial_excess" };
}

/** Cheapest eligible SKU that can fulfil the entire request on its own. */
export function bestSingleSku(req: PurchaseRequest, eligible: Offer[]): OrderOption | null {
  let best: OrderOption | null = null;
  for (const o of eligible) {
    const pv = o.packVolumeMl!;
    if (req.quantityMl % pv !== 0) continue;
    const packs = req.quantityMl / pv;
    if (packs > o.availablePacks) continue;
    const opt = buildOption("single", [{ offer: o, packs }], req);
    if (!best || compareOptions(opt, best) < 0) best = opt;
  }
  return best;
}

// ---------- exact-fill search (bounded multi-choice knapsack, Pareto DP) ----------

interface DPState {
  cost: number;
  date: string; // latest delivery date so far ("" = none)
  lines: number;
  sig: string;
  prev: DPState | null;
  offerIdx: number;
  packs: number;
}

function dominates(a: DPState, b: DPState): boolean {
  return a.cost <= b.cost && a.date <= b.date && a.lines <= b.lines;
}

function insertPareto(list: DPState[], s: DPState): void {
  for (let i = 0; i < list.length; i++) {
    const x = list[i];
    if (dominates(x, s)) {
      // Same rank tuple: keep the stable (lexicographically smaller) SKU set. Replace, never mutate:
      // states are shared as `prev` links across DP layers.
      if (x.cost === s.cost && x.date === s.date && x.lines === s.lines && s.sig < x.sig) list[i] = s;
      return;
    }
  }
  for (let i = list.length - 1; i >= 0; i--) if (dominates(s, list[i])) list.splice(i, 1);
  list.push(s);
}

export const MAX_DP_STEPS = 200_000;
export const MAX_DP_WORK = 500_000;

export interface FillSearchResult {
  exact: OrderOption | null;
  shortfall: OrderOption | null; // largest volume below the target
  excess: OrderOption | null; // smallest volume above the target
  bounded: boolean; // true if the search space had to be truncated
}

/**
 * Finds the cheapest exact fill over eligible SKUs using whole packs within stock.
 * Dynamic programming over volume in units of gcd(pack sizes, quantity); per volume we keep the
 * Pareto frontier of (cost, latest delivery date, line count) so the full ranking is respected.
 */
export function searchFills(req: PurchaseRequest, eligible: Offer[]): FillSearchResult {
  const offers = [...eligible].sort((a, b) =>
    a.priceCents! / a.packVolumeMl! - b.priceCents! / b.packVolumeMl! || a.sku.localeCompare(b.sku),
  );
  if (!offers.length) return { exact: null, shortfall: null, excess: null, bounded: false };
  let step = req.quantityMl;
  for (const o of offers) step = gcd(step, o.packVolumeMl!);
  const target = req.quantityMl / step;
  const maxPack = Math.max(...offers.map((o) => o.packVolumeMl! / step));
  let vmax = target + maxPack - 1;
  let bounded = false;
  if (vmax > MAX_DP_STEPS) {
    vmax = Math.min(vmax, MAX_DP_STEPS);
    bounded = true;
  }
  if (target > vmax) return { exact: null, shortfall: null, excess: null, bounded: true };

  let frontier: DPState[][] = Array.from({ length: vmax + 1 }, () => []);
  frontier[0].push({ cost: 0, date: "", lines: 0, sig: "", prev: null, offerIdx: -1, packs: 0 });

  let work = 0;
  for (const [idx, o] of offers.entries()) {
    const ps = o.packVolumeMl! / step;
    const next: DPState[][] = frontier.map((l) => [...l]);
    for (let v = 0; v <= vmax; v++) {
      if (++work > MAX_DP_WORK) {
        bounded = true;
        break;
      }
      const cur = frontier[v];
      if (!cur.length) continue;
      const kmax = Math.min(o.availablePacks, Math.floor((vmax - v) / ps));
      for (const s of cur) {
        const date = o.deliveryDate! > s.date ? o.deliveryDate! : s.date;
        const sig = s.sig ? [...s.sig.split(","), o.sku].sort().join(",") : o.sku;
        for (let k = 1; k <= kmax; k++) {
          if (++work > MAX_DP_WORK) {
            bounded = true;
            break;
          }
          insertPareto(next[v + k * ps], { cost: s.cost + k * o.priceCents!, date, lines: s.lines + 1, sig, prev: s, offerIdx: idx, packs: k });
        }
        if (work > MAX_DP_WORK) break;
      }
      if (work > MAX_DP_WORK) break;
    }
    frontier = next;
    if (work > MAX_DP_WORK) break;
  }

  const toOption = (s: DPState, kind: OrderOption["kind"]): OrderOption => {
    const picks: Array<{ offer: Offer; packs: number }> = [];
    for (let c: DPState | null = s; c && c.offerIdx >= 0; c = c.prev) picks.push({ offer: offers[c.offerIdx], packs: c.packs });
    return buildOption(kind, picks, req);
  };
  const best = (list: DPState[], kind: OrderOption["kind"]) =>
    list.length ? list.map((s) => toOption(s, kind)).sort(compareOptions)[0] : null;

  const exact = best(frontier[target], "combined");
  let shortfall: OrderOption | null = null;
  let excess: OrderOption | null = null;
  if (!exact) {
    for (let v = target - 1; v > 0 && !shortfall; v--) shortfall = best(frontier[v], "partial_shortfall");
    for (let v = target + 1; v <= vmax && !excess; v++) excess = best(frontier[v], "partial_excess");
  }
  return { exact, shortfall, excess, bounded };
}

export interface Comparison {
  request: PurchaseRequest;
  eligible: Offer[];
  excluded: ExcludedOffer[];
  single: OrderOption | null;
  combined: OrderOption | null;
  recommended: OrderOption | null;
  recommendedKind: "single" | "combined" | null;
  savingsCents: number | null; // single.total - combined.total when combined is cheaper
  contributions: Array<{ sku: string; volumeMl: number; sharePct: number; lineTotalCents: number }>;
  notes: string[];
  noFill: ReasonCode | null;
  partialOptions: OrderOption[]; // never submittable; buyer must revise the request first
  searchBounded: boolean;
}

export function compareOffers(req: PurchaseRequest, offers: Offer[]): Comparison {
  const { eligible, excluded } = evaluateEligibility(req, offers);
  const single = bestSingleSku(req, eligible);
  const fills = searchFills(req, eligible);
  const combined = fills.exact;
  const notes: string[] = [];
  let recommended: OrderOption | null = null;
  let recommendedKind: Comparison["recommendedKind"] = null;
  const exactOptions = [single, combined].filter((option): option is OrderOption => option !== null);
  const affordableOptions = req.budgetIsLimit && req.preferredBudgetCents != null
    ? exactOptions.filter((option) => option.totalCents <= req.preferredBudgetCents!)
    : [];
  const rankedOptions = affordableOptions.length ? affordableOptions : exactOptions;
  const budgetRecommendation = [...rankedOptions].sort(compareOptions)[0] ?? null;
  if (budgetRecommendation) {
    recommended = budgetRecommendation;
    recommendedKind = budgetRecommendation.kind === "combined" ? "combined" : "single";
  } else if (combined && (!single || compareOptions(combined, single) < 0) && combined.lines.length > 1) {
    recommended = combined;
    recommendedKind = "combined";
  } else if (single) {
    recommended = single;
    recommendedKind = "single";
  } else if (combined) {
    recommended = combined;
    recommendedKind = "combined";
  }
  if (req.budgetIsLimit && req.preferredBudgetCents != null && recommended && recommended.totalCents > req.preferredBudgetCents) {
    notes.push(`${fills.bounded ? "No exact option found" : "No exact option"} is within your ${formatEur(req.preferredBudgetCents)} budget limit. The ${fills.bounded ? "lowest-priced exact option found" : "lowest-priced exact option"} is ${formatEur(recommended.totalCents)}; a manager must approve any exception.`);
  }
  const savingsCents = single && combined && combined.totalCents < single.totalCents ? single.totalCents - combined.totalCents : null;
  if (!fills.bounded && single && combined && combined.lines.length === 1) notes.push("The cheapest exact fill is a single SKU; combining SKUs gives no saving.");
  if (savingsCents) notes.push(`Combining SKUs saves ${formatEur(savingsCents)} versus the best single SKU.`);
  if (!single && combined) notes.push("No single eligible SKU has enough stock for the whole request; a combination is required.");

  // Explain cheapest-SKU partial coverage (recovery from partial stock).
  const cheapestPerLitre = [...eligible].sort((a, b) => a.priceCents! / a.packVolumeMl! - b.priceCents! / b.packVolumeMl! || a.sku.localeCompare(b.sku))[0];
  if (cheapestPerLitre) {
    const cap = cheapestPerLitre.availablePacks * cheapestPerLitre.packVolumeMl!;
    if (cap < req.quantityMl)
      notes.push(
        `Cheapest SKU ${cheapestPerLitre.sku} (${formatEur(cheapestPerLitre.priceCents!)} per ${formatLitres(cheapestPerLitre.packVolumeMl!)}) covers only ${formatLitres(cap)} of ${formatLitres(req.quantityMl)}.`,
      );
  }

  const contributions =
    recommended?.lines.map((l) => ({
      sku: l.sku,
      volumeMl: l.volumeMl,
      sharePct: Math.round((l.volumeMl / recommended!.volumeMl) * 1000) / 10,
      lineTotalCents: l.lineTotalCents,
    })) ?? [];

  let noFill: ReasonCode | null = null;
  const partialOptions: OrderOption[] = [];
  if (!recommended) {
    if (!eligible.length) noFill = { code: "NO_ELIGIBLE_OFFER", message: "No SKU meets the product requirements and the delivery deadline." };
    else {
      const capacity = eligible.reduce((s, o) => s + o.availablePacks * o.packVolumeMl!, 0);
      if (capacity < req.quantityMl)
        noFill = {
          code: "INSUFFICIENT_STOCK",
          message: `Eligible stock totals ${formatLitres(capacity)}, short of the requested ${formatLitres(req.quantityMl)} by ${formatLitres(req.quantityMl - capacity)}.`,
        };
      else if (fills.bounded)
        noFill = {
          code: "SEARCH_LIMIT_REACHED",
          message: "The comparison reached its search limit before finding an exact match. Try a smaller quantity or a specific product.",
        };
      else
        noFill = {
          code: "PACK_SIZE_MISMATCH",
          message: `Available pack sizes (${[...new Set(eligible.map((o) => formatLitres(o.packVolumeMl!)))].join(", ")}) cannot add up to exactly ${formatLitres(req.quantityMl)} within stock.`,
        };
      if (fills.shortfall) partialOptions.push(fills.shortfall);
      if (fills.excess) partialOptions.push(fills.excess);
    }
  }
  if (fills.bounded) notes.push("The comparison reached its search limit. Some combinations were not checked, so the lowest possible price cannot be guaranteed.");
  return { request: req, eligible, excluded, single, combined, recommended, recommendedKind, savingsCents, contributions, notes, noFill, partialOptions, searchBounded: fills.bounded };
}
