import type { Offer, OrderOption, OrderTerms, PurchaseRequest, ReasonCode } from "./types.js";
import { canonicalJson, describeDate, formatEur, sha256 } from "./util.js";

export function termsFromOption(opt: OrderOption, req: PurchaseRequest): OrderTerms {
  return {
    currency: "EUR",
    lines: opt.lines.map((l) => ({ ...l })).sort((a, b) => a.sku.localeCompare(b.sku)),
    totalCents: opt.totalCents,
    volumeMl: opt.volumeMl,
    latestDeliveryDate: opt.latestDeliveryDate,
    deliveryDeadline: req.latestDeliveryDate,
  };
}

/** Stable fingerprint over the binding terms: SKU, quantity, unit price, total, currency and delivery terms. */
export function fingerprintTerms(t: OrderTerms): string {
  const binding = {
    currency: t.currency,
    totalCents: t.totalCents,
    deliveryDeadline: t.deliveryDeadline,
    lines: t.lines
      .map((l) => ({ sku: l.sku, packs: l.packs, packVolumeMl: l.packVolumeMl, unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents, deliveryDate: l.deliveryDate }))
      .sort((a, b) => a.sku.localeCompare(b.sku)),
  };
  return sha256(canonicalJson(binding));
}

export interface TermsChange {
  field: "sku_added" | "sku_removed" | "packs" | "unit_price" | "line_total" | "delivery_date" | "total" | "stock";
  sku?: string;
  old: string | number | null;
  new: string | number | null;
  message: string;
}

export interface TermsDiff {
  changed: boolean;
  totalDeltaCents: number;
  changes: TermsChange[];
}

export function diffTerms(a: OrderTerms, b: OrderTerms): TermsDiff {
  const changes: TermsChange[] = [];
  const am = new Map(a.lines.map((l) => [l.sku, l]));
  const bm = new Map(b.lines.map((l) => [l.sku, l]));
  for (const [sku, l] of am) {
    const n = bm.get(sku);
    if (!n) {
      changes.push({ field: "sku_removed", sku, old: l.packs, new: null, message: `SKU ${sku} removed (was ${l.packs} packs)` });
      continue;
    }
    if (n.packs !== l.packs) changes.push({ field: "packs", sku, old: l.packs, new: n.packs, message: `SKU ${sku} packs ${l.packs} → ${n.packs}` });
    if (n.unitPriceCents !== l.unitPriceCents)
      changes.push({ field: "unit_price", sku, old: l.unitPriceCents, new: n.unitPriceCents, message: `SKU ${sku} price per pack ${formatEur(l.unitPriceCents)} → ${formatEur(n.unitPriceCents)}` });
    if (n.lineTotalCents !== l.lineTotalCents)
      changes.push({ field: "line_total", sku, old: l.lineTotalCents, new: n.lineTotalCents, message: `SKU ${sku} line total ${formatEur(l.lineTotalCents)} → ${formatEur(n.lineTotalCents)}` });
    if (n.deliveryDate !== l.deliveryDate)
      changes.push({ field: "delivery_date", sku, old: l.deliveryDate, new: n.deliveryDate, message: `SKU ${sku} delivery ${describeDate(l.deliveryDate)} → ${describeDate(n.deliveryDate)}` });
  }
  for (const [sku, n] of bm) if (!am.has(sku)) changes.push({ field: "sku_added", sku, old: null, new: n.packs, message: `SKU ${sku} added (${n.packs} packs)` });
  const totalDeltaCents = b.totalCents - a.totalCents;
  if (totalDeltaCents !== 0)
    changes.push({ field: "total", old: a.totalCents, new: b.totalCents, message: `Total ${formatEur(a.totalCents)} → ${formatEur(b.totalCents)} (${totalDeltaCents > 0 ? "+" : ""}${formatEur(totalDeltaCents)})` });
  return { changed: fingerprintTerms(a) !== fingerprintTerms(b), totalDeltaCents, changes };
}

export interface Revalidation {
  valid: boolean; // terms unchanged and stock still covers every line
  requoted: OrderTerms | null; // same composition at current provider terms, if every line is still orderable
  problems: ReasonCode[];
}

/**
 * Compares stored terms with fresh provider offers. A stock change that still covers the order keeps the
 * terms valid; any change to price, items, quantity or delivery terms (or insufficient stock) invalidates them.
 */
export function revalidateTerms(terms: OrderTerms, req: PurchaseRequest, fresh: Offer[]): Revalidation {
  const bySku = new Map(fresh.map((o) => [o.sku, o]));
  const problems: ReasonCode[] = [];
  const lines: OrderTerms["lines"] = [];
  let orderable = true;
  for (const l of terms.lines) {
    const o = bySku.get(l.sku);
    if (!o) {
      problems.push({ code: "SKU_UNAVAILABLE", message: `SKU ${l.sku} is no longer offered` });
      orderable = false;
      continue;
    }
    if (o.salesBlock) {
      problems.push({ code: "SALES_BLOCKED", message: `SKU ${l.sku} is now blocked from sale` });
      orderable = false;
    }
    if (o.priceCents == null) {
      problems.push({ code: "NO_PRICE", message: `SKU ${l.sku} has no price` });
      orderable = false;
    } else if (o.priceCents !== l.unitPriceCents)
      problems.push({ code: "PRICE_CHANGED", message: `SKU ${l.sku} price changed ${formatEur(l.unitPriceCents)} → ${formatEur(o.priceCents)} per pack` });
    if (o.packVolumeMl !== l.packVolumeMl) {
      problems.push({ code: "PACK_SIZE_CHANGED", message: `SKU ${l.sku} pack size changed` });
      orderable = false;
    }
    if (!o.deliveryDate || o.deliveryDate > req.latestDeliveryDate) {
      problems.push({ code: "DELIVERY_LATE", message: `SKU ${l.sku} can no longer arrive by ${describeDate(req.latestDeliveryDate)}` });
      orderable = false;
    } else if (o.deliveryDate !== l.deliveryDate)
      problems.push({ code: "DELIVERY_CHANGED", message: `SKU ${l.sku} delivery changed ${describeDate(l.deliveryDate)} → ${describeDate(o.deliveryDate)}` });
    if (o.availablePacks < l.packs) {
      problems.push({ code: "STOCK_INSUFFICIENT", message: `SKU ${l.sku} has ${o.availablePacks} packs available; order needs ${l.packs}` });
      orderable = false;
    }
    for (const attr of req.requiredAttributes)
      if (o.attributes[attr] !== true) {
        problems.push({ code: "ATTRIBUTE_CHANGED", message: `SKU ${l.sku} no longer shows evidence for ${attr}` });
        orderable = false;
      }
    if (orderable && o.priceCents != null && o.deliveryDate)
      lines.push({ ...l, name: o.name, unitPriceCents: o.priceCents, lineTotalCents: o.priceCents * l.packs, deliveryDate: o.deliveryDate });
  }
  const requoted: OrderTerms | null = orderable
    ? {
        ...terms,
        lines,
        totalCents: lines.reduce((s, l) => s + l.lineTotalCents, 0),
        latestDeliveryDate: lines.reduce((m, l) => (l.deliveryDate > m ? l.deliveryDate : m), ""),
      }
    : null;
  return { valid: problems.length === 0, requoted, problems };
}
