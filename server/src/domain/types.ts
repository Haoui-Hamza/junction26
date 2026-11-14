// Core domain types. Money is integer euro cents, volume is integer millilitres, packs are integer counts.

export const SUPPORTED_ATTRIBUTES = ["lactose_free", "organic", "vegan"] as const;
export type Attribute = (typeof SUPPORTED_ATTRIBUTES)[number];

export interface PurchaseRequest {
  rawText?: string | null;
  category: string; // e.g. "milk", "plant_milk"
  requiredAttributes: Attribute[];
  quantity: number; // in `unit`, as the buyer stated it
  unit: "L";
  quantityMl: number; // canonical
  latestDeliveryDate: string; // YYYY-MM-DD, Europe/Helsinki calendar date
  preferredBudgetCents: number | null; // buyer's soft preference, NOT the policy limit
  budgetIsLimit?: boolean;
  requestedSku: string | null; // explicit SKU => no silent substitution
}

/** A fixed-price offer for one SKU, as returned by a provider for a requested delivery date. */
export interface Offer {
  sku: string;
  name: string;
  category: string;
  /** true = evidence says yes, false = evidence says no, null/undefined = no evidence. */
  attributes: Partial<Record<Attribute, boolean | null>>;
  evidence: Partial<Record<Attribute, string>>;
  packVolumeMl: number | null;
  packVolumeEvidence?: string;
  priceCents: number | null; // per pack, without tax
  currency: "EUR";
  availablePacks: number; // whole packs that can be ordered
  stockKnown: boolean; // false for supplier-terminal products (provider does not know the quantity)
  deliveryDate: string | null; // earliest delivery date (YYYY-MM-DD)
  closingTime: string | null; // order cut-off for that delivery
  salesBlock: boolean;
  offerVersion: string; // changes whenever price or delivery terms change
  /** Excluded by static product data before live price/availability was queried. */
  notQuoted?: boolean;
}

export interface ReasonCode {
  code: string;
  message: string;
}

export interface OptionLine {
  sku: string;
  name: string;
  packs: number;
  packVolumeMl: number;
  volumeMl: number;
  unitPriceCents: number;
  lineTotalCents: number;
  deliveryDate: string;
}

export type OptionKind = "single" | "combined" | "partial_shortfall" | "partial_excess";

export interface OrderOption {
  kind: OptionKind;
  lines: OptionLine[];
  totalCents: number;
  volumeMl: number;
  currency: "EUR";
  latestDeliveryDate: string;
  qualifies: string[]; // human-readable reasons why this option qualifies
  submittable: boolean;
}

/** Canonical, immutable terms of one proposal revision. The fingerprint is computed from these. */
export interface OrderTerms {
  currency: "EUR";
  lines: Array<{
    sku: string;
    name: string;
    packs: number;
    packVolumeMl: number;
    volumeMl: number;
    unitPriceCents: number;
    lineTotalCents: number;
    deliveryDate: string;
  }>;
  totalCents: number;
  volumeMl: number;
  latestDeliveryDate: string;
  deliveryDeadline: string;
}

export type OrderStatus =
  | "proposed"
  | "awaiting_approval"
  | "approved"
  | "requote_required"
  | "submitting"
  | "submitted"
  | "submission_unknown"
  | "rejected"
  | "returned_to_buyer";

export type Outcome =
  | "submitted"
  | "approval_required"
  | "approved"
  | "requote_required"
  | "no_eligible_offer"
  | "submission_outcome_unknown"
  | "submitting"
  | "rejected"
  | "stale_revision"
  | "submission_failed";

export type Role = "agent" | "buyer" | "approver";
export interface Actor {
  id: string;
  name: string;
  role: Role;
}
