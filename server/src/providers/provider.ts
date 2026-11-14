import type { Offer, PurchaseRequest, ReasonCode } from "../domain/types.js";

export interface SubmitLine {
  sku: string;
  packs: number;
  expectedUnitPriceCents: number;
  expectedDeliveryDate: string;
}

export interface SubmitOrderInput {
  submissionKey: string; // stable idempotency key
  lines: SubmitLine[];
  expectedTotalCents: number;
  currency: "EUR";
  requestedDeliveryDate: string;
}

export interface ProviderCapabilities {
  catalogSearch: boolean;
  revalidation: boolean;
  submitOrders: boolean;
  conditionalSubmit: boolean; // provider rejects the order atomically if terms changed
  idempotentSubmit: boolean; // provider deduplicates by submission key
  orderLookup: boolean; // provider can look up an order by submission key (reconciliation)
}

export interface ProviderInfo {
  id: "local" | "valio";
  label: string;
  description: string;
  orderMode?: "live" | "simulated" | "unavailable";
  capabilities: ProviderCapabilities;
  gaps: string[];
}

/** Catalog lookup, offer revalidation and order submission. Business decisions stay in the order service. */
export interface Provider {
  info: ProviderInfo;
  searchOffers(req: PurchaseRequest): Promise<Offer[]>;
  /** Fresh terms for specific SKUs for the requested delivery date (used for revalidation). */
  quoteOffers(skus: string[], requestedDeliveryDate: string): Promise<Offer[]>;
  submitOrder(input: SubmitOrderInput): Promise<{ providerOrderId: string }>;
  findOrderBySubmissionKey(submissionKey: string): Promise<{ providerOrderId: string } | null>;
}

/** Terms changed between revalidation and order creation; the provider refused the order. */
export class OfferChangedError extends Error {
  constructor(public problems: ReasonCode[]) {
    super(problems.map((p) => p.message).join("; "));
  }
}

/** The provider did not answer in time; the order may or may not exist. */
export class ProviderTimeoutError extends Error {}

export class ProviderNotSupportedError extends Error {}
